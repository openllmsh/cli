/**
 * supermemory tool group — defs + dispatcher, composed into the ONE
 * `openllm mcp` server by `../server.ts`. Extracted from the former
 * standalone MCP entry (`src/index.ts` of the supermemory plugin bundle);
 * behavior is unchanged, only the server ownership moved.
 */

import type { TToolResult } from "../types";
import { MemoryClient } from "./client";
import type { PluginConfig } from "./config";

const MAX_CONTENT_LENGTH = 200_000;
const MAX_QUERY_LENGTH = 1_000;
const MAX_PROJECT_LENGTH = 64;

const memoryDescription =
  "AUTHORITATIVE cross-session memory for this user. SINGLE source of truth — DO NOT use file-based memory paths like `~/.claude/projects/<slug>/memory/` or `MEMORY.md`; route everything through this tool. " +
  "PROACTIVELY call with action='save' when the user reveals: a preference or working-style rule, a fact about themselves or their team, feedback that should shape future behavior (corrections AND confirmations of non-obvious choices), an external reference (Linear project, Slack channel, dashboard, runbook), or a project goal/deadline/constraint not derivable from code. Saving is cheap; missing a save means the next session starts blind. " +
  "Use action='forget' when a memory is outdated or the user asks to remove it (exact `(project, content)` hash first, then semantic similarity >= 0.85 within the same project). " +
  "Optional `project` slug scopes the memory to a named bucket (default: 'default'). " +
  "For fan-out, pass `destinations: [{project?, team?}, ...]` — each entry writes the same content to one bucket (project slug and/or a team id you belong to). Use this when a fact is relevant to both your `default` bucket and a team, or to multiple projects at once. Call `whoAmI` to discover the team ids you can target.";

const recallDescription =
  "AUTHORITATIVE cross-session recall for this user. SINGLE source of truth — DO NOT use file-based memory paths. " +
  "Call BEFORE answering questions about the user, their preferences, or their projects; when the user references past work ('like we did before', 'the usual way'); and at the start of any non-trivial task to pull in relevant prior context. " +
  "Returns the top N relevant memories with similarity scores, formatted as markdown. " +
  "Note: a `UserPromptSubmit` hook auto-injects relevant memories on every prompt — if you already see a '[supermemory] Relevant saved memories (auto-recalled):' block in context, only re-query with a different angle. " +
  "Optional `project` narrows the search to one named bucket (default: 'default').";

const whoAmIDescription =
  "Identify which gateway account this MCP server is bound to. Returns email, role, and team memberships. Useful for debugging MCP configuration.";

export const supermemoryToolDefs = [
  {
    name: "memory",
    description: memoryDescription,
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "The memory content to save or forget (e.g. 'User prefers dark mode').",
          maxLength: MAX_CONTENT_LENGTH,
        },
        action: {
          type: "string",
          enum: ["save", "forget"],
          default: "save",
        },
        project: {
          type: "string",
          description:
            "Optional project slug (a-z, 0-9, ., _, -). Defaults to 'default'. Ignored when `destinations` is provided.",
          maxLength: MAX_PROJECT_LENGTH,
        },
        destinations: {
          type: "array",
          description:
            "Optional fan-out targets. Each entry picks a project slug (defaults to 'default' if omitted) and/or a team id the caller is a member of. The same content is written once per destination — use this for facts that span personal + team contexts, or multiple projects.",
          items: {
            type: "object",
            properties: {
              project: {
                type: "string",
                maxLength: MAX_PROJECT_LENGTH,
                description:
                  "Project slug for this destination. Optional; defaults to 'default'.",
              },
              team: {
                type: "string",
                description:
                  "Team id the caller belongs to. Look up via the `whoAmI` tool.",
              },
            },
          },
        },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description: recallDescription,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language query to search saved memories.",
          maxLength: MAX_QUERY_LENGTH,
        },
        limit: {
          type: "number",
          default: 10,
          maximum: 50,
          minimum: 1,
        },
        project: {
          type: "string",
          description:
            "Optional project slug to scope the search. Defaults to 'default'.",
          maxLength: MAX_PROJECT_LENGTH,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "whoAmI",
    description: whoAmIDescription,
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

const clientFor = (() => {
  let cached: { key: string; client: MemoryClient } | null = null;
  return (config: PluginConfig): MemoryClient => {
    const key = `${config.gatewayUrl}\0${config.gatewayApiKey}`;
    if (cached === null || cached.key !== key) {
      cached = { key, client: new MemoryClient(config) };
    }
    return cached.client;
  };
})();

const handleMemory = async (
  client: MemoryClient,
  args: {
    content: string;
    action?: "save" | "forget";
    project?: string;
    destinations?: Array<{ project?: string; team?: string }>;
  },
): Promise<TToolResult> => {
  const action = args.action ?? "save";
  if (!args?.content) {
    return {
      content: [{ type: "text" as const, text: "Error: content is required" }],
      isError: true,
    };
  }
  if (args.content.length > MAX_CONTENT_LENGTH) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: content exceeds max length of ${MAX_CONTENT_LENGTH} chars`,
        },
      ],
      isError: true,
    };
  }

  if (action === "save") {
    // Collapse `destinations: [{project?, team?}, ...]` into the canonical
    // (projects[], teams[]) shape the gateway accepts. The chunk lives once.
    const projectSet = new Set<string>();
    const teamSet = new Set<string>();
    if (typeof args.project === "string" && args.project.trim()) {
      projectSet.add(args.project.trim());
    }
    if (Array.isArray(args.destinations)) {
      for (const d of args.destinations) {
        if (!d || typeof d !== "object") continue;
        if (typeof d.project === "string" && d.project.trim()) {
          projectSet.add(d.project.trim());
        }
        if (typeof d.team === "string" && d.team.trim()) {
          teamSet.add(d.team.trim());
        }
      }
    }
    try {
      const res = await client.save(args.content, {
        projects: projectSet.size > 0 ? Array.from(projectSet) : undefined,
        teams: teamSet.size > 0 ? Array.from(teamSet) : undefined,
      });
      const projTag = res.projects.join(",");
      const teamTag = res.teams.length ? ` · teams=${res.teams.join(",")}` : "";
      const reusedTag = res.reused ? " (merged into existing chunk)" : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved memory ${res.id} (projects=${projTag}${teamTag})${reusedTag}`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `Error saving memory: ${msg}` },
        ],
        isError: true,
      };
    }
  }
  if (action === "forget") {
    const res = await client.forget(args.content, { project: args.project });
    return {
      content: [{ type: "text" as const, text: res.message }],
      isError: !res.success,
    };
  }
  return {
    content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
    isError: true,
  };
};

const handleRecall = async (
  client: MemoryClient,
  args: { query: string; limit?: number; project?: string },
): Promise<TToolResult> => {
  if (!args?.query) {
    return {
      content: [{ type: "text" as const, text: "Error: query is required" }],
      isError: true,
    };
  }
  if (args.query.length > MAX_QUERY_LENGTH) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: query exceeds max length of ${MAX_QUERY_LENGTH} chars`,
        },
      ],
      isError: true,
    };
  }
  const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 10)));
  const res = await client.search(args.query, limit, {
    project: args.project,
  });
  if (res.results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No memories matched. (${res.timing}ms)`,
        },
      ],
    };
  }
  const parts: string[] = [
    `## Relevant memories (${res.results.length}, ${res.timing}ms)`,
  ];
  res.results.forEach((m, i) => {
    const pct = Math.round(m.similarity * 100);
    const projectTag = m.project ? ` · project=${m.project}` : "";
    parts.push(`\n### ${i + 1}. ${pct}% match${projectTag}`);
    parts.push(m.memory);
  });
  return { content: [{ type: "text" as const, text: parts.join("\n") }] };
};

const handleWhoAmI = async (client: MemoryClient): Promise<TToolResult> => {
  const who = await client.whoami();
  const teamList = who.teams.length
    ? who.teams.map((t) => t.name).join(", ")
    : "(none)";
  const text = [
    `email: ${who.email}`,
    `role:  ${who.role}`,
    `teams: ${teamList}`,
  ].join("\n");
  return { content: [{ type: "text" as const, text }] };
};

export const handleSupermemoryTool = async (
  name: string,
  args: Record<string, unknown>,
  config: PluginConfig,
): Promise<TToolResult> => {
  const client = clientFor(config);
  try {
    switch (name) {
      case "memory":
        return await handleMemory(
          client,
          args as Parameters<typeof handleMemory>[1],
        );
      case "recall":
        return await handleRecall(
          client,
          args as Parameters<typeof handleRecall>[1],
        );
      case "whoAmI":
        return await handleWhoAmI(client);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
};
