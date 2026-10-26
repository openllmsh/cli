import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CLI_VERSION } from "../cli-version";
import type { TCliConfig } from "../env";
import { cliConfig, openllmDir } from "../env";
import type { SaveOptions } from "../mcp/memory/client";
import { MemoryClient } from "../mcp/memory/client";
import { callOperation } from "../sdk/client";
import { API_OPERATIONS } from "../sdk/generated/operations";
import { isPersonalMemoryEnabledCached } from "./enabled";
import { memoryEnv, RECALL_MARKER } from "./env";
import type { TProjectRef } from "./project-ref";
import { buildProjectRef } from "./project-ref";
import { MEMORY_EXTRACTION_PROMPT } from "./prompt";
import { MemoryHookState, numeric } from "./state";
import { memoryProject, recentTurns } from "./transcript";
import type { THookStage } from "./transport";
import {
  diagnosticOf,
  MemoryHookFailure,
  memoryHookTransport,
  recordOf,
} from "./transport";

/** Default recall HTTP budget (seconds). Hooks used to wait 5s; 2s fails open
 *  faster on a wedged gateway without changing successful RTT much. */
const DEFAULT_RECALL_TIMEOUT_S = 2;
/** Short TTL for identical prompt recalls within one coding burst. */
const RECALL_CACHE_TTL_MS = 60_000;

export type TMemoryHookOutput = {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
};
type TMemoryScope = "personal" | "project";
type TCandidate = { content: string; scope: TMemoryScope };
type TExtraction = { save: TCandidate[]; forget: TCandidate[] };
type TMatchedTeam = { id: string; name: string; slug?: string };

const cloudClient = (config: TCliConfig, timeoutMs: number): MemoryClient => {
  return new MemoryClient(
    {
      name: "openllm-memory",
      version: CLI_VERSION,
      gatewayUrl: config.gatewayUrl,
      gatewayApiKey: config.apiKey,
    },
    { timeoutMs, fetch: memoryHookTransport() },
  );
};

const invoke = async <TResult>(
  state: MemoryHookState,
  stage: THookStage,
  call: () => Promise<TResult>,
): Promise<TResult> => {
  try {
    return await call();
  } catch (error) {
    state.diagnostic(diagnosticOf(error, stage));
    throw error;
  }
};

const outputOf = (
  state: MemoryHookState,
  context?: string,
): TMemoryHookOutput | null => {
  const systemMessage = state.notice();
  return context || systemMessage
    ? {
        ...(systemMessage ? { systemMessage } : {}),
        ...(context
          ? {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: context,
              } as const,
            }
          : {}),
      }
    : null;
};

type TRecallCacheEntry = {
  readonly ts: number;
  readonly context: string | null;
};

/** Cap on cached recall files per account scope (expired ones pruned first). */
const RECALL_CACHE_MAX_FILES = 64;

const recallCachePath = (
  accountScope: string,
  project: string,
  prompt: string,
): string => {
  // Lives under ~/.openllm/cache — NOT the plugin-state diagnostic dir, which
  // must never retain recalled memory text (transcript sentinels, secrets).
  const dir = join(openllmDir(), "cache", "memory-recall", accountScope);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = createHash("sha256")
    .update(`${project}\0${prompt}`)
    .digest("hex")
    .slice(0, 32);
  return join(dir, `${key}.json`);
};

const unlinkQuiet = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
};

const readRecallCache = (path: string): TRecallCacheEntry | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("ts" in value) ||
      typeof value.ts !== "number"
    ) {
      unlinkQuiet(path);
      return null;
    }
    const age = Date.now() - value.ts;
    if (age < 0 || age > RECALL_CACHE_TTL_MS) {
      // Expired entries hold recalled memory text at rest — delete on sight.
      unlinkQuiet(path);
      return null;
    }
    const context =
      "context" in value &&
      (typeof value.context === "string" || value.context === null)
        ? value.context
        : null;
    return { ts: value.ts, context };
  } catch {
    return null;
  }
};

const pruneRecallCacheDir = (dir: string): void => {
  try {
    const names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    if (names.length === 0) return;
    const now = Date.now();
    const kept: { path: string; ts: number }[] = [];
    for (const name of names) {
      const path = join(dir, name);
      try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        const ts =
          typeof value === "object" &&
          value !== null &&
          "ts" in value &&
          typeof value.ts === "number"
            ? value.ts
            : null;
        if (ts === null || now - ts < 0 || now - ts > RECALL_CACHE_TTL_MS) {
          unlinkQuiet(path);
          continue;
        }
        kept.push({ path, ts });
      } catch {
        unlinkQuiet(path);
      }
    }
    if (kept.length <= RECALL_CACHE_MAX_FILES) return;
    kept.sort((a, b) => a.ts - b.ts);
    for (const entry of kept.slice(0, kept.length - RECALL_CACHE_MAX_FILES)) {
      unlinkQuiet(entry.path);
    }
  } catch {
    /* best-effort cache hygiene */
  }
};

const writeRecallCache = (path: string, context: string | null): void => {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ ts: Date.now(), context }), {
      mode: 0o600,
    });
    renameSync(temp, path);
    pruneRecallCacheDir(dirname(path));
  } catch {
    unlinkQuiet(temp);
  }
};

/** Foreground prompt hook: fail-open, filtered project + global data injection. */
export const runMemoryRecall = async (
  input: unknown,
): Promise<TMemoryHookOutput | null> => {
  if ((memoryEnv("AUTO_RECALL") ?? "1") !== "1") return null;
  const event = recordOf(input);
  if (!event || typeof event.prompt !== "string") return null;
  let prompt = event.prompt
    .trim()
    .replace(/^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/, "$1")
    .trim();
  // Skip shell bangs, slash-commands, and trivial prompts (acks / one-word).
  // The no-whitespace check is ASCII-only: CJK / Thai prompts routinely have
  // no spaces between words, so a bare `!/\s/` would disable recall for them.
  const asciiOnly = [...prompt].every((ch) => (ch.codePointAt(0) ?? 0) < 0x80);
  if (
    prompt.length < 6 ||
    prompt.startsWith("!") ||
    prompt.startsWith("/") ||
    (!/\s/.test(prompt) && prompt.length < 16 && asciiOnly)
  )
    return null;
  const config = cliConfig();
  if (!config.apiKey || !config.gatewayUrl) return null;
  // One cheap cached check — fail-open = skip (never block the prompt).
  if (!(await isPersonalMemoryEnabledCached(config))) return null;
  let state: MemoryHookState;
  try {
    state = new MemoryHookState(config.gatewayUrl, config.apiKey, "recall");
  } catch {
    return null;
  }
  try {
    const limit = Math.trunc(numeric(memoryEnv("RECALL_LIMIT"), 5, 1, 20));
    const minSimilarity = numeric(
      memoryEnv("RECALL_MIN_SIMILARITY"),
      0.25,
      0,
      1,
    );
    const maxChars = Math.trunc(
      numeric(memoryEnv("RECALL_MAX_PROMPT"), 1000, 16, 1000),
    );
    prompt = prompt.slice(0, maxChars);
    const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
    const project = memoryProject(cwd, memoryEnv("RECALL_PROJECT"));
    const projectRef = buildProjectRef(cwd, project);
    const cacheEnabled = (memoryEnv("RECALL_CACHE") ?? "1") === "1";
    let cachePath: string | null = null;
    if (cacheEnabled) {
      try {
        cachePath = recallCachePath(
          createHash("sha256")
            .update(`${config.gatewayUrl}\0${config.apiKey}`)
            .digest("hex")
            .slice(0, 32),
          project,
          prompt,
        );
        const cached = readRecallCache(cachePath);
        if (cached) {
          state.health("success");
          state.log({
            outcome: cached.context ? "recall" : "noop",
            hits: cached.context ? 1 : 0,
          });
          return outputOf(state, cached.context ?? undefined);
        }
      } catch {
        // Cache setup/read failures are a miss — fall through to search.
        cachePath = null;
      }
    }
    const client = cloudClient(
      config,
      numeric(memoryEnv("RECALL_TIMEOUT"), DEFAULT_RECALL_TIMEOUT_S, 0.5, 15) *
        1000,
    );
    const found = await client.search(prompt, limit, {
      projects: project === "default" ? [project] : [project, "default"],
      project_ref: projectRef,
    });
    const hits = found.results
      .filter(
        (memory) =>
          typeof memory.memory === "string" &&
          memory.memory.trim() &&
          Number.isFinite(memory.similarity) &&
          memory.similarity >= minSimilarity,
      )
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    state.health("success");
    state.log({ outcome: hits.length ? "recall" : "noop", hits: hits.length });
    if (!hits.length) {
      if (cachePath !== null) writeRecallCache(cachePath, null);
      return outputOf(state);
    }
    const lines = [
      `${RECALL_MARKER} Relevant saved memories (auto-recalled):`,
      ...hits.map((memory) => {
        const text = memory.memory.trim();
        const content =
          text.length > 500 ? `${text.slice(0, 500).trimEnd()}…` : text;
        const bucket = recallBucketLabel(memory, project);
        return `- (${Math.round(memory.similarity * 100)}% · ${bucket}) ${content}`;
      }),
    ];
    const context = lines.join("\n");
    if (cachePath !== null) writeRecallCache(cachePath, context);
    return outputOf(state, context);
  } catch (error) {
    state.diagnostic(diagnosticOf(error, "recall"));
    state.health("failure");
    return outputOf(state);
  }
};

const recallBucketLabel = (
  memory: { project?: string; team_name?: string | null },
  fallbackProject: string,
): string => {
  const project = memory.project || fallbackProject;
  const teamName =
    typeof memory.team_name === "string" ? memory.team_name.trim() : "";
  if (teamName) return `team ${teamName} · ${project}`;
  return project;
};

const scopeOf = (value: unknown): TMemoryScope =>
  value === "personal" ? "personal" : "project";

const extractionOf = (body: unknown): TExtraction => {
  const choices = recordOf(body)?.choices;
  const first = Array.isArray(choices) ? recordOf(choices[0]) : null;
  const content = recordOf(first?.message)?.content;
  if (typeof content !== "string")
    throw new MemoryHookFailure({
      stage: "parse",
      code: "invalid_model_output",
    });
  const match = content.match(/\{[\s\S]*\}/);
  let object: Record<string, unknown> | null = null;
  try {
    object = recordOf(JSON.parse(match?.[0] ?? ""));
  } catch {
    /* Classified below, never copy model output. */
  }
  if (!object || !("save" in object || "forget" in object))
    throw new MemoryHookFailure({
      stage: "parse",
      code: "invalid_model_output",
    });
  const forgetCandidates = (value: unknown): TCandidate[] => {
    if (!Array.isArray(value))
      throw new MemoryHookFailure({
        stage: "parse",
        code: "invalid_model_output",
      });
    return value.flatMap((item): TCandidate[] => {
      const candidate = recordOf(item);
      if (!candidate || typeof candidate.content !== "string") return [];
      return [{ content: candidate.content.trim(), scope: "project" }];
    });
  };
  const saveCandidates = (value: unknown): TCandidate[] => {
    if (!Array.isArray(value))
      throw new MemoryHookFailure({
        stage: "parse",
        code: "invalid_model_output",
      });
    return value.flatMap((item): TCandidate[] => {
      const candidate = recordOf(item);
      if (!candidate || typeof candidate.content !== "string") return [];
      return [
        {
          content: candidate.content.trim(),
          scope: scopeOf(candidate.scope),
        },
      ];
    });
  };
  return {
    save: saveCandidates("save" in object ? object.save : []),
    forget: forgetCandidates("forget" in object ? object.forget : []),
  };
};

const hookSaveOptions = (
  opts: SaveOptions & { project_ref: TProjectRef },
): SaveOptions => ({
  ...opts,
  metadata: { ...(opts.metadata ?? {}), source: "hook" },
});

/** Called in the detached compiled CLI worker. No provider discovery/auth: the
 * launcher passes its already-resolved inference origin; storage stays cloud.
 */
export const runMemoryExtraction = async (input: unknown): Promise<void> => {
  if ((memoryEnv("AUTO_SAVE") ?? "1") !== "1") return;
  const event = recordOf(input);
  if (
    !event ||
    event.stop_hook_active === true ||
    event.stopHookActive === true
  )
    return;
  const transcript = event.transcript_path ?? event.transcriptPath;
  const sessionId = event.session_id ?? event.sessionId;
  if (typeof transcript !== "string" || !transcript) return;
  const config = cliConfig();
  if (!config.apiKey || !config.gatewayUrl) return;
  // One cheap cached check — fail-open = skip (never block extract).
  if (!(await isPersonalMemoryEnabledCached(config))) return;
  let state: MemoryHookState;
  let session: ReturnType<MemoryHookState["session"]>;
  let size: number;
  try {
    const stat = statSync(transcript);
    if (!stat.isFile()) return;
    size = stat.size;
    state = new MemoryHookState(config.gatewayUrl, config.apiKey, "extract");
    session = state.session(
      typeof sessionId === "string" ? sessionId : "",
      transcript,
    );
  } catch {
    return;
  }
  if (!session) return;
  const { previous } = session;
  const now = Date.now();
  const interval = numeric(memoryEnv("AUTO_MIN_INTERVAL"), 30, 0, 86400) * 1000;
  const stamp = (success: boolean): void =>
    state.stamp(session.path, {
      ...(success
        ? { size }
        : previous.size === undefined
          ? {}
          : { size: previous.size }),
      ts: success ? Date.now() : previous.ts,
      attemptTs: Date.now(),
      failed: !success,
    });
  try {
    if (
      previous.size === size ||
      now - previous.ts < interval ||
      (previous.failed &&
        now - previous.attemptTs <
          Math.max(30_000, Math.min(300_000, interval)))
    )
      return;
    const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
    const project = memoryProject(cwd, memoryEnv("AUTO_PROJECT"));
    const projectRef = buildProjectRef(cwd, project);
    const maxTurns = Math.trunc(
      numeric(memoryEnv("AUTO_MAX_TURNS"), 12, 2, 40),
    );
    let turns: ReturnType<typeof recentTurns>;
    try {
      turns = recentTurns(transcript, maxTurns);
    } catch {
      throw new MemoryHookFailure({
        stage: "transcript",
        code: "unreadable_transcript",
      });
    }
    if (turns.length < 2) {
      stamp(true);
      // No HTTP happened, so this local no-op cannot prove an earlier
      // transport failure recovered. Keep its degraded health until verified.
      state.log({ outcome: "noop" });
      return;
    }
    // A crashed worker remains retryable after cooldown, never permanently
    // completed. The final stamp below records completion-time cooldown.
    stamp(false);
    const client = cloudClient(config, 3000);
    // Matched teams are informational for the model and used for project-scope
    // fan-out. Fail open to "no teams" so extraction still runs personally.
    const matchedTeams: TMatchedTeam[] = await invoke(state, "match", () =>
      client.match(projectRef),
    )
      .then((result) =>
        Array.isArray(result.teams)
          ? result.teams.filter(
              (team) =>
                typeof team.id === "string" && typeof team.name === "string",
            )
          : [],
      )
      .catch(() => []);
    const knownProjects = await invoke(state, "projects", () =>
      client.listProjects(),
    ).catch(() => []);
    const lastUser = [...turns]
      .reverse()
      .find((turn) => turn.role === "user")?.text;
    const seedQuery = (
      lastUser ||
      turns
        .slice(-3)
        .map((turn) => turn.text)
        .join(" ")
    ).slice(0, 800);
    const existing = await invoke(state, "context", () =>
      client.search(seedQuery, 20, { project, project_ref: projectRef }),
    )
      .then((result) =>
        result.results.filter(
          (memory) => typeof memory.memory === "string" && memory.memory.trim(),
        ),
      )
      .catch(() => []);
    const known = [
      ...new Set([
        project,
        "default",
        ...knownProjects.filter((name) => typeof name === "string" && name),
      ]),
    ].slice(0, 30);
    const teamBelonging = matchedTeams.length
      ? matchedTeams.map((team) => team.name).join(", ")
      : "(none — team sharing disabled for this project)";
    const userBlock = `CURRENT PROJECT: ${project}\nKNOWN PROJECTS (prefer these slugs): ${known.join(", ")}\nTHIS PROJECT BELONGS TO TEAM(S): ${teamBelonging}\n\nEXISTING MEMORIES FOR THIS PROJECT:\n${
      existing.length
        ? existing
            .slice(0, 20)
            .map((memory) => `- ${memory.memory}`)
            .join("\n")
        : "(none)"
    }\n\nRECENT CONVERSATION TURNS (oldest → newest):\n${turns.map((turn) => `[${turn.role}]\n${turn.text}`).join("\n\n")}`;
    const operation = API_OPERATIONS.find(
      (candidate) => candidate.id === "v1ChatCompletions.chatCompletions",
    );
    if (!operation)
      throw new MemoryHookFailure({
        stage: "inference",
        code: "missing_operation",
      });
    const response = await callOperation(
      {
        baseUrl: process.env.OPENLLM_INFERENCE_ORIGIN || config.gatewayUrl,
        apiKey: config.apiKey,
      },
      operation,
      {
        body: {
          model: memoryEnv("AUTO_MODEL") || "lite",
          messages: [
            { role: "system", content: MEMORY_EXTRACTION_PROMPT },
            { role: "user", content: userBlock },
          ],
          // No `temperature`: the `lite` chain leads with subscription hops
          // whose native runtimes have no sampling knob and decline it.
          max_tokens: 700,
        },
      },
      { timeoutMs: 30_000, fetch: memoryHookTransport() },
    );
    const extraction = extractionOf(response.body);
    const mutations = cloudClient(config, 5000);
    let saved = 0;
    let forgotten = 0;
    let duplicates = 0;
    let errors = 0;
    for (const item of extraction.forget) {
      if (item.content.length < 6 || item.content.length > 4000) continue;
      try {
        if (
          (
            await invoke(state, "forget", () =>
              mutations.forgetExact(item.content, { project }),
            )
          ).deleted > 0
        )
          forgotten++;
      } catch {
        errors++;
      }
    }
    const matchedTeamIds = matchedTeams.map((team) => team.id);
    const dedupe = numeric(memoryEnv("AUTO_DEDUPE_SIM"), 0.85, 0, 1);
    for (const item of extraction.save) {
      if (item.content.length < 12 || item.content.length > 4000) continue;
      const personalProjects =
        item.scope === "personal" ? ["default"] : [project];
      const matches = await invoke(state, "dedupe", () =>
        client.search(item.content, 3, {
          projects: personalProjects,
          project_ref: projectRef,
        }),
      ).catch(() => null);
      if (
        matches?.results.some(
          (memory) =>
            Number.isFinite(memory.similarity) && memory.similarity >= dedupe,
        )
      ) {
        duplicates++;
        continue;
      }
      try {
        await invoke(state, "save", async () => {
          // Personal prefs never fan out to teams. Project facts always get a
          // personal project row first; matched teams are a second write.
          const personal = await mutations.save(
            item.content,
            hookSaveOptions({
              projects: personalProjects,
              project_ref: projectRef,
            }),
          );
          if (personal.status !== "saved")
            throw new MemoryHookFailure({
              stage: "save",
              code: "invalid_response",
            });
          if (item.scope === "project" && matchedTeamIds.length > 0) {
            const shared = await mutations.save(
              item.content,
              hookSaveOptions({
                projects: [project],
                teams: matchedTeamIds,
                project_ref: projectRef,
              }),
            );
            if (shared.status !== "saved")
              throw new MemoryHookFailure({
                stage: "save",
                code: "invalid_response",
              });
          }
        });
        saved++;
      } catch {
        errors++;
      }
    }
    stamp(errors === 0);
    state.log({
      outcome: errors ? "failure" : "success",
      saved,
      forgotten,
      duplicates,
      errors,
    });
    state.health(
      errors ? "failure" : saved ? "saved" : forgotten ? "success" : "noop",
      saved,
    );
  } catch (error) {
    state.diagnostic(
      diagnosticOf(
        error,
        error instanceof MemoryHookFailure
          ? error.diagnostic.stage
          : "inference",
      ),
    );
    try {
      stamp(false);
    } catch {
      /* Unwritable state cannot poison future processing. */
    }
    state.health("failure");
  } finally {
    session.release();
  }
};
