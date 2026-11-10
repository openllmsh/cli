/** Authenticated OS-local adapter. Provider work stays in the running daemon. */
import type {
  TAuthPayload,
  TAuthRelayResult,
  TDaemonCommand,
  TDaemonCommandAck,
  TDaemonStatus,
  TLocalAuthMethod,
  TLocalAuthRequest,
} from "@openllmsh/sdk/protocol";
import {
  AUTH_LOCAL_MAX_BODY_BYTES,
  AUTH_LOCAL_PATH,
  AUTH_LOCAL_VERSION,
  DaemonCommand,
  PENDING_AUTH_TTL_MS,
  parseLocalAuthRequest,
} from "@openllmsh/sdk/protocol";
import { Schema } from "effect";
import { readRoster } from "./account-roster";
import { AccountKeyedMap } from "./account-scope";
import {
  localAgentRefusal,
  localAgentRefusalResponse,
  localPreflightRefusal,
} from "./agent/loopback";
import { requestStatusPush } from "./auth-events";
import {
  authRevision,
  latestAuthStatus,
  waitForAuthChange,
} from "./auth-watch";
import type { TCliProvider } from "./cli-paths";
import { runCommandInner } from "./control-relay";
import { DELEGATES, getDelegate } from "./delegation";
import { loginSlot } from "./delegation/login-flow";
import { daemonPublicKey, openSealed, sealTo } from "./keypair";
import { localControlCorsHeaders } from "./local-device-control";
import {
  localAccessFailure,
  localJson,
  readBoundedLocalJson,
} from "./local-http";
import { runWithAccount } from "./op-context";
import { getPendingAuth, pendingAuthWire } from "./pending-auth";
import { scheduleDaemonCommand } from "./scheduled-command";
import { computeStatus, loginAdmittedForCommand } from "./status";
import { peekUsage } from "./usage-cache";

export const localAuthProviders = (): readonly {
  provider: string;
  default_method: TLocalAuthMethod;
  methods: readonly TLocalAuthMethod[];
  actions: readonly string[];
}[] =>
  Object.values(DELEGATES).map((delegate) => {
    const primary = delegate.primaryLoginMethod ?? "browser";
    return {
      provider: delegate.slug,
      default_method: primary,
      methods:
        primary === "device" || delegate.connectDeviceCode === undefined
          ? [primary]
          : [primary, "device"],
      actions: [
        "status",
        "usage",
        "refresh",
        "login",
        "cancel",
        "logout",
        ...(delegate.submitLoginCode !== undefined ? ["submit-code"] : []),
      ],
    };
  });

type TLocalFlow = {
  readonly id: string;
  /** Private continuation handle; never the command id published in auth events/status. */
  readonly token: string;
  readonly startedAt: number;
  ack?: TDaemonCommandAck;
};
// At most one retained originating login per provider account, in memory for this boot.
const localFlows = new AccountKeyedMap<TLocalFlow>();
const localFlowOf = (provider: string, id: string): TLocalFlow | null => {
  const flow = localFlows.get(provider);
  if (flow === undefined || flow.token !== id) return null;
  if (
    Date.now() - flow.startedAt > PENDING_AUTH_TTL_MS &&
    loginSlot(provider).flow()?.flowId !== flow.id
  ) {
    localFlows.delete(provider);
    return null;
  }
  return flow;
};

const MESSAGE_MAX = 200;
/**
 * A failure's readable reason (the daemon's `error` / `detail` text), for
 * people and agents alike. Scrubbed: gateway keys and links are replaced and
 * it is capped, so no secret, auth URL or long vendor dump rides it.
 */
export const outcomeMessage = (result: unknown): string | undefined => {
  if (result === null || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  const raw =
    typeof record.detail === "string" && record.detail.trim() !== ""
      ? record.detail
      : typeof record.error === "string"
        ? record.error
        : undefined;
  if (raw === undefined) return undefined;
  const scrubbed = raw
    .replace(/sk-llm-[A-Za-z0-9._-]+/g, "[key]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]")
    .replace(/\s+/g, " ")
    .trim();
  if (scrubbed === "") return undefined;
  return scrubbed.length > MESSAGE_MAX
    ? `${scrubbed.slice(0, MESSAGE_MAX - 1)}…`
    : scrubbed;
};

/** Never echo raw vendor output, auth URLs, pasted codes, or another flow's id in command results. */
const commandOutcome = (ack: TDaemonCommandAck): Record<string, unknown> => {
  const result = ack.result as Record<string, unknown> | undefined;
  const message =
    ack.status === "error" ? outcomeMessage(ack.result) : undefined;
  return {
    command_status: ack.status,
    ...(message !== undefined ? { message } : {}),
    ...(ack.status === "error"
      ? {
          error:
            typeof result?.error === "string" &&
            [
              "login_conflict",
              "flow_mismatch",
              "overflow",
              "apply_busy",
              "continuation_idle",
              "duplicate_account",
              "unknown account",
              "unknown provider",
            ].includes(result.error)
              ? result.error
              : "command_failed",
        }
      : {}),
    ...(result?.retryable === true ? { retryable: true } : {}),
    ...(typeof result?.connected === "boolean"
      ? { connected: result.connected }
      : {}),
    ...(typeof result?.pending === "boolean"
      ? { pending: result.pending }
      : {}),
    ...(typeof result?.ok === "boolean" ? { ok: result.ok } : {}),
    ...(result?.deferred !== undefined ? { deferred: result.deferred } : {}),
  };
};

const flowSnapshot = (
  provider: string,
  flow: TLocalFlow,
): Record<string, unknown> => {
  const pending = getPendingAuth(provider);
  const connected = loginAdmittedForCommand(provider, flow.id);
  const live = loginSlot(provider).flow()?.flowId === flow.id;
  return {
    flow_id: flow.token,
    // The id this flow's auth events and status markers carry — public
    // already, so the owner can match them to its own flow.
    event_flow_id: flow.id,
    ...(flow.ack !== undefined
      ? commandOutcome(flow.ack)
      : { command_status: "running" }),
    connected,
    pending: !connected && (live || flow.ack === undefined),
    state: connected
      ? "connected"
      : live
        ? "pending"
        : flow.ack === undefined
          ? "running"
          : "ended",
    ...(pending?.localOnly === true &&
    pending.flowId === flow.id &&
    loginSlot(provider).flow()?.flowId === flow.id
      ? {
          prompt: pendingAuthWire({
            ...pending,
            localOnly: false,
            flowId: flow.token,
          }),
        }
      : {}),
  };
};

const statusBody = (
  status: TDaemonStatus,
  provider: string | undefined,
  account: number | undefined,
  flow: TLocalFlow | null,
): Record<string, unknown> => {
  const providers = status.connections
    .filter((one) => provider === undefined || one.provider === provider)
    .filter(
      (one) => account === undefined || (one.account_index ?? 0) === account,
    )
    .map((one) => {
      // Browser-originated prompts never escape through OS-local discovery.
      if (one.pending_auth === undefined || one.pending_auth === null)
        return one;
      const { pending_auth: pending, detail: _detail, ...rest } = one;
      return {
        ...rest,
        detail: "Sign-in is running on this machine.",
        pending_auth: {
          pending: true,
          started_at_ms: pending.started_at_ms,
          cancel_requested: pending.cancel_requested,
        },
      };
    });
  return {
    providers,
    ...(flow !== null && provider !== undefined
      ? { flow: flowSnapshot(provider, flow) }
      : {}),
  };
};

const execute = async (
  command: TDaemonCommand,
  flowId?: string,
): Promise<TDaemonCommandAck> => {
  let result: TDaemonCommandAck | undefined;
  const denied = await scheduleDaemonCommand(command, async () => {
    result = await runCommandInner(command, {
      localOnly: true,
      expectedLoginFlowId: flowId,
    });
  });
  // Updates the canonical local snapshot even without a connected relay; reads never refresh usage.
  await computeStatus();
  requestStatusPush();
  return denied ?? result ?? { id: command.id, status: "error" };
};

/**
 * `/local/auth`. A caller without an `Origin` (the CLI, MCP) keeps the strict
 * owner gate. A page — only the desktop app's, which alone is handed the
 * capability (`local_agent_auth`) — gets the same admission and CORS as
 * `/local/device-control`: loopback peer, an allowed origin, the capability.
 */
export const handleLocalAuth = async (
  req: Request,
  remoteAddress?: string | null,
): Promise<Response> => {
  if (req.headers.has("origin")) {
    if (req.method === "OPTIONS") {
      const refused = localPreflightRefusal(req, remoteAddress);
      return refused !== null
        ? localAgentRefusalResponse(refused)
        : withLocalCors(req, new Response(null, { status: 204 }));
    }
    const refused = localAgentRefusal(req, remoteAddress);
    if (refused !== null) return localAgentRefusalResponse(refused);
    return withLocalCors(req, await serveLocalAuth(req));
  }
  const failure = localAccessFailure(req);
  if (failure !== null) return localJson(403, { error: failure });
  return serveLocalAuth(req);
};

const withLocalCors = (req: Request, res: Response): Response => {
  for (const [name, value] of Object.entries(localControlCorsHeaders(req)))
    res.headers.set(name, value);
  return res;
};

const serveLocalAuth = async (req: Request): Promise<Response> => {
  if (new URL(req.url).pathname !== AUTH_LOCAL_PATH)
    return localJson(404, { error: "not_found" });
  if (req.method !== "POST")
    return localJson(405, { error: "method_not_allowed" });
  const body = await readBoundedLocalJson(req, AUTH_LOCAL_MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  let input: TLocalAuthRequest;
  try {
    input = parseLocalAuthRequest(body);
  } catch {
    return localJson(400, { error: "invalid" });
  }
  // Flows, pending prompts and login slots are per account slot.
  return runWithAccount(input.account ?? 0, () =>
    handleParsed(input, req.signal),
  );
};

/**
 * The relay's `auth` command: the same request, the same handler and the same
 * reply as loopback `/local/auth`. Only the transport differs — the code is
 * opened from its sealed box here, then the request is validated exactly as a
 * CLI request is. The flow token in a `login` reply goes back only to the
 * caller that sent it, so holding it is what owns the flow on every surface.
 */
export const runRelayedAuth = async (
  payload: TAuthPayload,
): Promise<TAuthRelayResult> => {
  const { sealed_code: sealed, ...rest } = payload;
  let input: TLocalAuthRequest;
  try {
    input = parseLocalAuthRequest(
      sealed === undefined ? rest : { ...rest, code: await openSealed(sealed) },
    );
  } catch {
    return {
      status: 400,
      body: { version: AUTH_LOCAL_VERSION, error: "invalid" },
    };
  }
  const response = await runWithAccount(input.account ?? 0, () =>
    handleParsed(input),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

/** The roster slot `account` of `provider` exists (account 0 always does). */
const knownAccount = (provider: string, account: number): boolean =>
  account === 0 ||
  readRoster(provider as TCliProvider).accounts.some(
    (a) => a.index === account,
  );

const handleParsed = async (
  input: TLocalAuthRequest,
  signal?: AbortSignal,
): Promise<Response> => {
  const provider = input.provider;
  const delegate = provider !== undefined ? getDelegate(provider) : null;
  if (provider !== undefined && delegate === null)
    return localJson(400, {
      version: AUTH_LOCAL_VERSION,
      error: "unknown_provider",
    });
  const reply = (status: number, result: Record<string, unknown>): Response =>
    localJson(status, { version: AUTH_LOCAL_VERSION, ...result });
  const account = input.account;
  if (
    provider !== undefined &&
    account !== undefined &&
    input.operation !== "pin-account" &&
    !knownAccount(provider, account)
  )
    return reply(400, { error: "unknown_account" });
  const accountField = account !== undefined ? { account_index: account } : {};
  try {
    if (input.operation === "providers")
      return reply(200, { providers: localAuthProviders() });
    if (input.operation === "usage") {
      const selected = Object.values(DELEGATES).filter(
        (one) => provider === undefined || one.slug === provider,
      );
      // Usage is keyed by roster hash (`slug#hash`). The bare/unscoped key is
      // account 0's legacy fallback only — never serve it for account n>=1.
      const slotUsage = (slug: string, index: number): unknown => {
        const hash = readRoster(slug as TCliProvider).accounts.find(
          (a) => a.index === index,
        )?.account_hash;
        if (hash != null) return peekUsage(slug, hash) ?? null;
        if (index === 0) return peekUsage(slug) ?? null;
        return null;
      };
      if (account !== undefined)
        return reply(200, {
          usage: Object.fromEntries(
            selected.map((one) => [one.slug, slotUsage(one.slug, account)]),
          ),
        });
      // Account 0 keeps the legacy shape; extra slots ride `accounts`.
      const accounts = Object.fromEntries(
        selected
          .map(
            (one) =>
              [
                one.slug,
                readRoster(one.slug as TCliProvider).accounts,
              ] as const,
          )
          .filter(([, slots]) => slots.length > 1)
          .map(([slug, slots]) => [
            slug,
            slots.map((a) => ({
              account_index: a.index,
              usage: slotUsage(slug, a.index),
            })),
          ]),
      );
      return reply(200, {
        usage: Object.fromEntries(
          selected.map((one) => [one.slug, slotUsage(one.slug, 0)]),
        ),
        ...(Object.keys(accounts).length > 0 ? { accounts } : {}),
      });
    }
    if (input.operation === "status") {
      const flow =
        provider !== undefined && input.flow_id !== undefined
          ? localFlowOf(provider, input.flow_id)
          : null;
      if (input.flow_id !== undefined && flow === null)
        return reply(409, { error: "flow_not_owned_or_expired" });
      const body = async (
        recompute: boolean,
      ): Promise<Record<string, unknown>> =>
        statusBody(
          recompute
            ? await computeStatus()
            : (latestAuthStatus() ?? (await computeStatus())),
          provider,
          account,
          flow,
        );
      let result = await body(true);
      let revision = authRevision(result);
      // Long-poll: hold until the snapshot differs from the caller's revision.
      if (input.since !== undefined && input.wait_ms !== undefined) {
        const deadline = Date.now() + input.wait_ms;
        while (revision === input.since) {
          const left = deadline - Date.now();
          if (left <= 0) break;
          const wake = await waitForAuthChange(left, signal);
          if (wake === "timeout") break;
          result = await body(wake === "event");
          revision = authRevision(result);
        }
      }
      return reply(200, { ...result, revision });
    }
    const owned =
      provider !== undefined && input.flow_id !== undefined
        ? localFlowOf(provider, input.flow_id)
        : null;
    // Reading a prompt or submitting a code needs the private token. Cancel is
    // only a stop, so any caller may stop the live sign-in: by its token, by
    // the public id its status marker carries (a reloaded tab), or — with no
    // id — whatever sign-in is live for this provider account.
    const live =
      provider !== undefined ? loginSlot(provider).flow()?.flowId : undefined;
    const cancelTarget =
      input.operation !== "cancel"
        ? undefined
        : owned !== null
          ? owned.id
          : input.flow_id === undefined || input.flow_id === live
            ? live
            : undefined;
    if (input.operation === "cancel" && cancelTarget === undefined)
      return reply(409, { error: "flow_not_owned_or_expired" });
    if (
      input.operation !== "cancel" &&
      input.flow_id !== undefined &&
      owned === null
    )
      return reply(409, { error: "flow_not_owned_or_expired" });
    const id = crypto.randomUUID();
    let raw: unknown;
    switch (input.operation) {
      case "login": {
        if (provider === undefined || delegate === null)
          return reply(400, { error: "unknown_provider" });
        const primary = delegate.primaryLoginMethod ?? "browser";
        const method = input.method ?? primary;
        if (
          method !== primary &&
          (method !== "device" || delegate.connectDeviceCode === undefined)
        )
          return reply(400, { error: "unsupported_method" });
        const command = Schema.decodeUnknownSync(DaemonCommand)({
          id,
          kind: method === primary ? "connect" : "connect_device_code",
          payload: { slug: provider, ...accountField },
        });
        // Admission reserves synchronously. Never claim ownership of a duplicate/resurfaced relay flow.
        if (
          localFlows.get(provider)?.ack === undefined &&
          localFlows.has(provider)
        )
          return reply(409, { error: "login_in_progress" });
        const flow: TLocalFlow = {
          id,
          token: crypto.randomUUID(),
          startedAt: Date.now(),
        };
        const previous = localFlows.get(provider);
        localFlows.set(provider, flow);
        let denied = false;
        const work = scheduleDaemonCommand(command, async () => {
          flow.ack = await runCommandInner(command, { localOnly: true });
          await computeStatus();
          requestStatusPush();
        })
          .then((rejection) => {
            if (rejection === null) return;
            denied = true;
            flow.ack = { id, status: "error" };
            if (localFlows.get(provider) === flow) {
              if (previous !== undefined) localFlows.set(provider, previous);
              else localFlows.delete(provider);
            }
          })
          .catch(() => {
            flow.ack = { id, status: "error" };
          });
        // Bounded response even when queued behind a refresh or waiting for vendor consent.
        await Promise.race([
          work,
          new Promise<void>((resolve) => setTimeout(resolve, 0)),
        ]);
        if (denied)
          return reply(409, { error: "login_conflict", retryable: true });
        return reply(flow.ack?.status === "error" ? 409 : 200, {
          ...flowSnapshot(provider, flow),
        });
      }
      case "refresh":
        raw = {
          id,
          kind: "refresh",
          payload: {
            ...(provider !== undefined
              ? { slug: provider, ...accountField }
              : {}),
            manual: true,
          },
        };
        break;
      case "logout":
        raw = {
          id,
          kind: "logout",
          payload: { slug: provider, ...accountField },
        };
        break;
      case "add-account":
        raw = {
          id,
          kind: "add_account",
          payload: {
            slug: provider,
            ...(input.label !== undefined ? { label: input.label } : {}),
          },
        };
        break;
      case "remove-account":
        raw = {
          id,
          kind: "remove_account",
          payload: { slug: provider, account_index: account },
        };
        break;
      case "pin-account":
        raw = {
          id,
          kind: "pin_account",
          payload: { slug: provider, account_index: account },
        };
        break;
      case "unpin-account":
        raw = {
          id,
          kind: "pin_account",
          payload: { slug: provider, account_index: null },
        };
        break;
      case "cancel":
        raw = {
          id,
          kind: "cancel_connect",
          payload: {
            slug: provider,
            ...accountField,
            ...(cancelTarget !== undefined ? { flow_id: cancelTarget } : {}),
          },
        };
        break;
      case "submit-code": {
        if (
          provider === undefined ||
          input.flow_id === undefined ||
          input.code === undefined ||
          localFlowOf(provider, input.flow_id) === null
        )
          return reply(409, { error: "flow_not_owned_or_expired" });
        if (delegate?.submitLoginCode === undefined)
          return reply(400, { error: "unsupported_action" });
        raw = {
          id,
          kind: "submit_login_code",
          payload: {
            slug: provider,
            ...accountField,
            sealed: await sealTo(daemonPublicKey(), input.code),
          },
        };
        break;
      }
    }
    const ack = await execute(
      Schema.decodeUnknownSync(DaemonCommand)(raw),
      cancelTarget ?? owned?.id,
    );
    const accountResult = ack.result as Record<string, unknown> | undefined;
    return reply(ack.status === "error" ? 409 : 200, {
      ...commandOutcome(ack),
      ...(typeof accountResult?.account_index === "number" &&
      input.operation.endsWith("-account")
        ? { account_index: accountResult.account_index }
        : {}),
    });
  } catch {
    return reply(500, { error: "local_auth_failed" });
  }
};
