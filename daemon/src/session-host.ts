/**
 * Durable session-host registry adapter.
 *
 * Every PTY now belongs to an independent `openllmd __session-host` process.
 * This module preserves the historical import surface for daemon status and boot
 * reconciliation while never creating or retaining a daemon-owned session.
 */

import type { TDeviceSessionCli } from "@openllmsh/protocol";
import { discoverSessionHosts } from "./session-host-proc";

/**
 * Adopt live durable session-host directories and reap stale entries. Discovery
 * validates pid + socket asynchronously under a shared outer deadline. Unknown
 * process identity never authorizes deletion. A confirmed-alive process is
 * never reaped even if its socket is missing; it is not listed as attachable
 * until the socket exists. Expiry returns the last complete scan for status
 * and stops starting probes — it does not keep reaping in the background.
 */
export const reapOrphanSessionProcs = async (): Promise<void> => {
  await discoverSessionHosts();
};

/** Reconcile without touching live sibling session-host processes. */
export const reconcileSessionHostsAtBoot = reapOrphanSessionProcs;

/** Durable discovery rows for compatibility consumers and picker merges. */
export const sessionStatusReport = async (): Promise<
  Array<{
    id: string;
    cli: TDeviceSessionCli;
    started_at_ms: number;
    attached: boolean;
    live: boolean;
    busy: boolean;
    title?: string;
    vendor_session_id?: string | null;
  }>
> =>
  (await discoverSessionHosts()).map((host) => ({
    id: host.id,
    cli: host.cli,
    started_at_ms: host.startedAtMs,
    attached: false,
    live: true,
    busy: false,
    ...(host.title === null ? {} : { title: host.title }),
    ...(host.vendorSessionId === null
      ? {}
      : { vendor_session_id: host.vendorSessionId }),
  }));

export const deviceSessionsForList = async (): Promise<
  ReadonlyArray<{
    readonly id: string;
    readonly cli: TDeviceSessionCli;
    readonly live: boolean;
    readonly title: string | null;
    readonly vendor_session_id: string | null;
    readonly cwd: string;
    readonly started_at_ms: number;
  }>
> =>
  (await discoverSessionHosts()).map((host) => ({
    id: host.id,
    cli: host.cli,
    live: true,
    title: host.title,
    vendor_session_id: host.vendorSessionId,
    cwd: host.cwd,
    started_at_ms: host.startedAtMs,
  }));

export { ptySupported } from "./session-core";
