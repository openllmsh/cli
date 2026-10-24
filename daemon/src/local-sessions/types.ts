/**
 * Local session index types — the daemon-side view of vendor history +
 * `~/.openllm/run` live processes, normalized to `TLocalCliSession` for the
 * control command `list_local_sessions`.
 */

import type { TDeviceSessionCli, TLocalCliSession } from "@openllmsh/protocol";

/** openllm client id used under `~/.openllm/run/<client>/`. */
export type TOpenllmClientId =
  | "claude"
  | "codex"
  | "grok"
  | "opencode"
  | "hermes";

/** Vendor cold-resume argv style. */
export type TDeviceCliResume =
  | { readonly kind: "flag"; readonly flag: "--resume" | "--session" }
  | { readonly kind: "subcommand"; readonly name: "resume" }
  | { readonly kind: "none" };

/**
 * Which history reader a CLI uses. Absent means no reader (hermes, shell).
 * Mapped to the actual reader in `index.ts` to avoid a types↔reader cycle.
 */
export type TDeviceCliHistoryId = "claude" | "codex" | "grok" | "opencode";

export type TDeviceCliSpec = {
  readonly clientId: TOpenllmClientId | null;
  readonly resume: TDeviceCliResume;
  readonly listable: boolean;
  readonly history?: TDeviceCliHistoryId;
};

/**
 * Single exhaustive device-CLI catalog. A missing union member is a type error.
 */
export const DEVICE_CLI_RECORD = {
  claude_code: {
    clientId: "claude",
    resume: { kind: "flag", flag: "--resume" },
    listable: true,
    history: "claude",
  },
  chatgpt: {
    clientId: "codex",
    resume: { kind: "subcommand", name: "resume" },
    listable: true,
    history: "codex",
  },
  grok: {
    clientId: "grok",
    resume: { kind: "flag", flag: "--resume" },
    listable: true,
    history: "grok",
  },
  opencode: {
    clientId: "opencode",
    resume: { kind: "flag", flag: "--session" },
    listable: true,
    history: "opencode",
  },
  hermes: {
    clientId: "hermes",
    resume: { kind: "flag", flag: "--resume" },
    listable: true,
  },
  shell: {
    clientId: null,
    resume: { kind: "none" },
    listable: false,
  },
} as const satisfies Record<TDeviceSessionCli, TDeviceCliSpec>;

export type TListableDeviceCli = {
  [K in TDeviceSessionCli]: (typeof DEVICE_CLI_RECORD)[K]["listable"] extends true
    ? K
    : never;
}[TDeviceSessionCli];

const DEVICE_CLI_KEYS = Object.keys(DEVICE_CLI_RECORD) as TDeviceSessionCli[];

/** Device CLI slugs that have a local history reader in v1 (shell excluded). */
export const LISTABLE_DEVICE_CLIS = DEVICE_CLI_KEYS.filter(
  (cli): cli is TListableDeviceCli => DEVICE_CLI_RECORD[cli].listable,
);

export const isListableDeviceCli = (
  cli: TDeviceSessionCli,
): cli is TListableDeviceCli =>
  (LISTABLE_DEVICE_CLIS as readonly string[]).includes(cli);

/** Map device CLI → openllm client id (and run-dir name). */
export const openllmClientIdOf = (
  cli: TDeviceSessionCli,
): TOpenllmClientId | null => DEVICE_CLI_RECORD[cli]?.clientId ?? null;

const CLIENT_ID_TO_CLI = {} as Record<TOpenllmClientId, TListableDeviceCli>;
for (const cli of DEVICE_CLI_KEYS) {
  const id = DEVICE_CLI_RECORD[cli].clientId;
  if (id !== null) {
    CLIENT_ID_TO_CLI[id] = cli as TListableDeviceCli;
  }
}

export const deviceCliOfClientId = (
  clientId: TOpenllmClientId,
): TListableDeviceCli => CLIENT_ID_TO_CLI[clientId];

/** Append vendor cold-resume flags for a known session id. */
export const pushDeviceCliResumeArgs = (
  args: string[],
  cli: TDeviceSessionCli,
  vendorSessionId: string,
): void => {
  const resume = DEVICE_CLI_RECORD[cli]?.resume;
  if (resume === undefined) return;
  switch (resume.kind) {
    case "flag":
      args.push(resume.flag, vendorSessionId);
      break;
    case "subcommand":
      args.push(resume.name, vendorSessionId);
      break;
    case "none":
      break;
  }
};

/** Intermediate history row before live merge. */
export type THistorySession = {
  readonly id: string;
  readonly title: string;
  readonly cwd: string | null;
  readonly updated_at_ms: number;
  readonly cli: TDeviceSessionCli;
};

/** One live.json entry that passed the liveness check. */
export type TLiveRun = {
  readonly client: TOpenllmClientId;
  readonly pid: number;
  readonly cwd: string;
  readonly started_at_ms: number;
  readonly host: "local" | "device";
  readonly openllm_session_id: string | null;
  readonly vendor_session_id: string | null;
  readonly title: string | null;
};

export type { TLocalCliSession };
