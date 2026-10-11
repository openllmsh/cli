/** Authenticated OS-local adapter. Provider work stays in the running daemon. */
import type {
  TDaemonCommand,
  TDaemonCommandAck,
  TLocalAuthMethod,
  TLocalAuthRequest,
} from "@openllmsh/protocol";
import {
  AUTH_LOCAL_MAX_BODY_BYTES,
  AUTH_LOCAL_PATH,
  AUTH_LOCAL_VERSION,
  DaemonCommand,
  PENDING_AUTH_TTL_MS,
  parseLocalAuthRequest,
} from "@openllmsh/protocol";
import { Schema } from "effect";
import { requestStatusPush } from "./auth-events";
import { runCommandInner } from "./control-relay";
import { DELEGATES, getDelegate } from "./delegation";
import { loginSlot } from "./delegation/login-flow";
import { daemonPublicKey, sealTo } from "./keypair";
import {
  localAccessFailure,
  localJson,
  readBoundedLocalJson,
} from "./local-http";
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
// At most one retained originating login per provider, in memory for this boot.
const localFlows = new Map<string, TLocalFlow>();
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

/** Never echo vendor output, auth URLs, pasted codes, or another flow's id in command results. */
const commandOutcome = (ack: TDaemonCommandAck): Record<string, unknown> => {
  const result = ack.result as Record<string, unknown> | undefined;
  return {
    command_status: ack.status,
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

export const handleLocalAuth = async (req: Request): Promise<Response> => {
  const failure = localAccessFailure(req);
  if (failure !== null) return localJson(403, { error: failure });
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
  const provider = input.provider;
  const delegate = provider !== undefined ? getDelegate(provider) : null;
  if (provider !== undefined && delegate === null)
    return localJson(400, {
      version: AUTH_LOCAL_VERSION,
      error: "unknown_provider",
    });
  const reply = (status: number, result: Record<string, unknown>): Response =>
    localJson(status, { version: AUTH_LOCAL_VERSION, ...result });
  try {
    if (input.operation === "providers")
      return reply(200, { providers: localAuthProviders() });
    if (input.operation === "usage")
      return reply(200, {
        usage: Object.fromEntries(
          Object.values(DELEGATES)
            .filter((one) => provider === undefined || one.slug === provider)
            .map((one) => [one.slug, peekUsage(one.slug) ?? null]),
        ),
      });
    if (input.operation === "status") {
      const flow =
        provider !== undefined && input.flow_id !== undefined
          ? localFlowOf(provider, input.flow_id)
          : null;
      if (input.flow_id !== undefined && flow === null)
        return reply(409, { error: "flow_not_owned_or_expired" });
      const status = await computeStatus();
      const providers = status.connections
        .filter((one) => provider === undefined || one.provider === provider)
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
      return reply(200, {
        providers,
        ...(flow !== null && provider !== undefined
          ? { flow: flowSnapshot(provider, flow) }
          : {}),
      });
    }
    const candidate =
      provider !== undefined ? localFlows.get(provider) : undefined;
    const owned =
      provider !== undefined && input.flow_id !== undefined
        ? localFlowOf(provider, input.flow_id)
        : input.operation === "cancel" &&
            provider !== undefined &&
            candidate !== undefined &&
            loginSlot(provider).flow()?.flowId === candidate.id
          ? candidate
          : null;
    if (
      (input.flow_id !== undefined || input.operation === "cancel") &&
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
          payload: { slug: provider },
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
            ...(provider !== undefined ? { slug: provider } : {}),
            manual: true,
          },
        };
        break;
      case "logout":
        raw = { id, kind: "logout", payload: { slug: provider } };
        break;
      case "cancel":
        raw = {
          id,
          kind: "cancel_connect",
          payload: {
            slug: provider,
            ...(owned !== null ? { flow_id: owned.id } : {}),
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
            sealed: sealTo(daemonPublicKey(), input.code),
          },
        };
        break;
      }
    }
    const ack = await execute(
      Schema.decodeUnknownSync(DaemonCommand)(raw),
      owned?.id,
    );
    return reply(ack.status === "error" ? 409 : 200, commandOutcome(ack));
  } catch {
    return reply(500, { error: "local_auth_failed" });
  }
};
