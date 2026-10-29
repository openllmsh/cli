/**
 * Titles for durable session hosts, resolved exactly as the device session
 * list (`list_local_sessions`) resolves them — vendor history first, then the
 * shared "New session · <CLI>" label — so `openllm sessions` and the
 * `openllm <client>` attach picker name a session the same way the browser does.
 */

import type { TDeviceSessionCli } from "@openllmsh/protocol";
import { readLocalSessions } from "./index";

export type TSessionHostTitleInput = {
  readonly id: string;
  readonly cli: TDeviceSessionCli;
  readonly cwd: string;
  readonly vendorSessionId: string | null;
  readonly startedAtMs: number;
};

/** Host id → title. Hosts the device list can't name are left out. */
export const sessionHostTitles = async (
  hosts: readonly TSessionHostTitleInput[],
): Promise<ReadonlyMap<string, string>> => {
  const titles = new Map<string, string>();
  const clis = [...new Set(hosts.map((host) => host.cli))];
  const deviceSessions = hosts.map((host) => ({
    id: host.id,
    cli: host.cli,
    live: true,
    title: null,
    vendor_session_id: host.vendorSessionId,
    cwd: host.cwd,
    started_at_ms: host.startedAtMs,
  }));
  const rows = await Promise.all(
    clis.map((cli) =>
      readLocalSessions(cli, {
        limit: 100,
        deps: { deviceSessions: () => deviceSessions },
      }).catch(() => []),
    ),
  );
  for (const row of rows.flat()) {
    const id = row.openllm_session_id;
    if (typeof id === "string") titles.set(id, row.title);
  }
  return titles;
};
