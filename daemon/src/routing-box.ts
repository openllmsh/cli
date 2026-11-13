/**
 * Is this daemon running on an OpenLLM routing box?
 *
 * A routing box (a Pro user's small GalaxyGate VM, docs/plans/routing-sandbox.md)
 * marks itself with `ROUTING_BOX_MARKER_PATH`, written by its user-data.
 * There the daemon:
 *
 *   - keeps auto-update always on: the box can't be pinned to an old binary
 *     (`auto-update-pref.ts`);
 *   - refuses device sessions: the box is too small to run agents, so no
 *     install anchor is accepted or read (`device-anchor.ts`, `env.ts`).
 *
 * Everything else is exactly as on any machine.
 *
 * `OPENLLM_ROUTING_BOX_MARKER` moves the marker. Pointing it elsewhere on a
 * real box only turns these locks off for that process, which the box's
 * owner (root on their own machine) can do anyway.
 */
import { existsSync } from "node:fs";
import { ROUTING_BOX_MARKER_PATH } from "@openllmsh/sdk/protocol";

export const routingBoxMarkerPath = (): string =>
  process.env.OPENLLM_ROUTING_BOX_MARKER ?? ROUTING_BOX_MARKER_PATH;

export const isRoutingBox = (): boolean => existsSync(routingBoxMarkerPath());
