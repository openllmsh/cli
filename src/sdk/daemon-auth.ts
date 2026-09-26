/**
 * Node-only: wires the daemon's per-boot local caller credential into the SDK
 * transport (`sdk/client.ts`). Kept out of `client.ts` because that module is
 * also bundled into the web app, which must never import `../env` (`node:fs`,
 * `node:os`, `node:path`). Installed once from the CLI entry (`main.ts`).
 */
import {
  daemonTokenPorts,
  LOCAL_CALLER_TOKEN_HEADER,
  localCallerToken,
} from "../env";
import { setDaemonCallerAuth } from "./client";

export const installDaemonCallerAuth = (): void => {
  setDaemonCallerAuth({
    ports: daemonTokenPorts,
    header: LOCAL_CALLER_TOKEN_HEADER,
    token: localCallerToken,
  });
};
