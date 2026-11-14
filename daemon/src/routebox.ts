/**
 * Is this daemon running on an OpenLLM Routebox?
 *
 * A Routebox (a Pro user's small GalaxyGate VM, docs/plans/routebox.md)
 * marks itself with `ROUTEBOX_MARKER_PATH`, written by its user-data.
 * There the daemon:
 *
 *   - keeps auto-update always on: the box can't be pinned to an old binary
 *     (`auto-update-pref.ts`);
 *   - refuses device sessions: the box is too small to run agents. It keeps
 *     its install anchor (the control pin is what lets a browser open a
 *     direct WebRTC tunnel to it), and `agentSessionRefusal` refuses every
 *     seed-gated stream open instead (`device-access-verify.ts`).
 *
 * Everything else is exactly as on any machine.
 *
 * `OPENLLM_ROUTEBOX_MARKER` moves the marker. Pointing it elsewhere on a
 * real box only turns these locks off for that process, which the box's
 * owner (root on their own machine) can do anyway.
 */
import { existsSync } from "node:fs";
import { ROUTEBOX_MARKER_PATH } from "@openllmsh/sdk/protocol";

export const routeboxMarkerPath = (): string =>
  process.env.OPENLLM_ROUTEBOX_MARKER ?? ROUTEBOX_MARKER_PATH;

export const isRoutebox = (): boolean => existsSync(routeboxMarkerPath());
