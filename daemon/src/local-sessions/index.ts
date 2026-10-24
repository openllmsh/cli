/**
 * Local session index: vendor history + `~/.openllm/run` live.json +
 * in-memory device PTYs, merged for `list_local_sessions`.
 */

import type { TDeviceSessionCli, TLocalCliSession } from "@openllmsh/protocol";
import { LISTABLE_SESSION_CLIS } from "@openllmsh/protocol";
import { readClaudeHistory } from "./claude";
import { readCodexHistory } from "./codex";
import { readGrokHistory } from "./grok";
import { readLiveRuns } from "./live-run";
import { readOpencodeHistory } from "./opencode";
import { TITLE_MAX } from "./title";
import type { TDeviceCliHistoryId, THistorySession, TLiveRun } from "./types";
import {
  DEVICE_CLI_RECORD,
  deviceCliOfClientId,
  isListableDeviceCli,
  openllmClientIdOf,
} from "./types";

export * from "./types";

const DEFAULT_LIMIT = 30;
const HARD_CAP = 100;

/** Optional injectors for tests. */
export type TLocalSessionsDeps = {
  readonly readHistory?: (
    cli: TDeviceSessionCli,
    limit: number,
  ) => Promise<THistorySession[]>;
  readonly readLive?: (cli: TDeviceSessionCli) => Promise<TLiveRun[]>;
  /** In-memory device PTYs from session-host (same process). */
  readonly deviceSessions?: () => ReadonlyArray<{
    readonly id: string;
    readonly cli: TDeviceSessionCli;
    readonly live: boolean;
    readonly title?: string | null;
    readonly vendor_session_id?: string | null;
    readonly cwd?: string | null;
    readonly started_at_ms: number;
  }>;
};

const HISTORY_READERS: Record<
  TDeviceCliHistoryId,
  (limit: number) => THistorySession[] | Promise<THistorySession[]>
> = {
  claude: readClaudeHistory,
  codex: readCodexHistory,
  grok: readGrokHistory,
  opencode: readOpencodeHistory,
};

const defaultHistory = async (
  cli: TDeviceSessionCli,
  limit: number,
): Promise<THistorySession[]> => {
  const spec = DEVICE_CLI_RECORD[cli];
  const historyId = "history" in spec ? spec.history : undefined;
  if (historyId === undefined) return [];
  return HISTORY_READERS[historyId](limit);
};

const defaultLive = async (cli: TDeviceSessionCli): Promise<TLiveRun[]> => {
  const clientId = openllmClientIdOf(cli);
  if (clientId === null) return [];
  return readLiveRuns(clientId);
};

export const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  return Math.min(n, HARD_CAP);
};

/**
 * List local sessions for one device CLI. Never throws — empty on missing
 * stores or read errors.
 */
export const readLocalSessions = async (
  cli: TDeviceSessionCli,
  opts: { readonly limit?: number; readonly deps?: TLocalSessionsDeps } = {},
): Promise<TLocalCliSession[]> => {
  const limit = clampLimit(opts.limit);
  const deps = opts.deps ?? {};
  // Defense-in-depth: only CLIs with a local history reader are listable; keep
  // the guard so shell and future non-listable slugs fail closed to empty rather
  // than half-reading an unknown store.
  if (!isListableDeviceCli(cli)) return [];

  const readHistory = deps.readHistory ?? defaultHistory;
  const readLive = deps.readLive ?? defaultLive;

  const [history, liveRuns] = await Promise.all([
    readHistory(cli, limit),
    readLive(cli),
  ]);
  const device = deps.deviceSessions?.() ?? [];

  type TRow = {
    id: string;
    title: string;
    cwd: string | null;
    updated_at_ms: number;
    live: boolean;
    host: "local" | "device" | null;
    openllm_session_id: string | null;
    attachable: boolean;
  };

  const byKey = new Map<string, TRow>();
  const byOpenllmId = new Map<string, string>();

  const mergeRows = (previous: TRow, row: TRow): TRow => ({
    id: row.id.length > 0 ? row.id : previous.id,
    title:
      row.title !== "Untitled" && row.title.length > 0
        ? row.title
        : previous.title,
    cwd: row.cwd ?? previous.cwd,
    updated_at_ms: Math.max(row.updated_at_ms, previous.updated_at_ms),
    live: row.live || previous.live,
    host: row.host ?? previous.host,
    openllm_session_id: row.openllm_session_id ?? previous.openllm_session_id,
    attachable: row.attachable || previous.attachable,
  });

  const put = (row: TRow, key: string): void => {
    const openllmId = row.openllm_session_id;
    const existingKey =
      openllmId !== null && openllmId.length > 0
        ? byOpenllmId.get(openllmId)
        : undefined;
    const targetKey = existingKey ?? key;
    const previous = byKey.get(targetKey);
    const merged = previous === undefined ? row : mergeRows(previous, row);
    byKey.set(targetKey, merged);
    if (openllmId !== null && openllmId.length > 0) {
      byOpenllmId.set(openllmId, targetKey);
    }
  };

  for (const h of history) {
    put(
      {
        id: h.id,
        title: h.title,
        cwd: h.cwd,
        updated_at_ms: h.updated_at_ms,
        live: false,
        host: null,
        openllm_session_id: null,
        attachable: false,
      },
      `vendor:${h.id}`,
    );
  }

  for (const live of liveRuns) {
    if (deviceCliOfClientId(live.client) !== cli) continue;
    // Key priority: vendor id (merge with vendor history) → openllm id (merge
    // with the in-memory device loop's `openllm:${id}`) → pid. Without the
    // openllm fallback, a device live.json with no vendor id would key by pid
    // and duplicate the same session's in-memory device row.
    const hasVendorSessionId =
      live.vendor_session_id !== null && live.vendor_session_id.length > 0;
    const vendorKey = hasVendorSessionId
      ? `vendor:${live.vendor_session_id}`
      : live.openllm_session_id !== null && live.openllm_session_id.length > 0
        ? `openllm:${live.openllm_session_id}`
        : `live:${live.pid}`;
    const attachable =
      live.host === "device" &&
      live.openllm_session_id !== null &&
      live.openllm_session_id.length > 0;
    put(
      {
        id: hasVendorSessionId
          ? live.vendor_session_id
          : live.openllm_session_id !== null &&
              live.openllm_session_id.length > 0
            ? live.openllm_session_id
            : `live-${live.pid}`,
        title: live.title ?? "Untitled",
        cwd: live.cwd,
        updated_at_ms: live.started_at_ms,
        live: true,
        host: live.host,
        openllm_session_id: live.openllm_session_id,
        attachable,
      },
      vendorKey,
    );
  }

  for (const s of device) {
    if (s.cli !== cli) continue;
    const vendorSessionId =
      s.vendor_session_id !== null &&
      s.vendor_session_id !== undefined &&
      s.vendor_session_id.length > 0
        ? s.vendor_session_id
        : null;
    const vendorKey =
      vendorSessionId !== null
        ? `vendor:${vendorSessionId}`
        : `openllm:${s.id}`;
    put(
      {
        id: vendorSessionId ?? s.id,
        title: s.title ?? "Untitled",
        cwd: s.cwd ?? null,
        updated_at_ms: s.started_at_ms,
        live: s.live,
        host: s.live ? "device" : null,
        openllm_session_id: s.id,
        attachable: s.live,
      },
      vendorKey,
    );
  }

  return [...byKey.values()]
    .sort((a, b) => {
      // Attachable live first, then other live, then by recency.
      if (a.attachable !== b.attachable) return a.attachable ? -1 : 1;
      if (a.live !== b.live) return a.live ? -1 : 1;
      return b.updated_at_ms - a.updated_at_ms;
    })
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      title: r.title.slice(0, TITLE_MAX),
      cwd: r.cwd,
      updated_at_ms: r.updated_at_ms,
      cli,
      live: r.live,
      host: r.host,
      openllm_session_id: r.openllm_session_id,
      attachable: r.attachable,
    }));
};

/**
 * List every supported local CLI, preserving the per-CLI merge behavior.
 * The limit applies to the COMBINED result: each CLI reads unlimited, then
 * the flattened rows are re-sorted with the same attachable → live →
 * recency ordering `readLocalSessions` uses, so one chatty CLI can't
 * crowd a quieter one out via per-group truncation.
 */
export const readAllLocalSessions = async (
  opts: { readonly limit?: number; readonly deps?: TLocalSessionsDeps } = {},
): Promise<TLocalCliSession[]> => {
  const limit = clampLimit(opts.limit);
  const groups = await Promise.all(
    [...LISTABLE_SESSION_CLIS].map((cli) =>
      readLocalSessions(cli, { limit: 100, deps: opts.deps }),
    ),
  );
  return groups
    .flat()
    .sort((a, b) => {
      if (a.attachable !== b.attachable) return a.attachable ? -1 : 1;
      if (a.live !== b.live) return a.live ? -1 : 1;
      return b.updated_at_ms - a.updated_at_ms;
    })
    .slice(0, limit);
};
