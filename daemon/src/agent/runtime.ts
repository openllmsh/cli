/**
 * Daemon-wide agent runtime: the ONE dispatcher both front doors share, and
 * its registration on the mux host (which also turns on the `agent1` cap).
 */
import type { TAgentEngine } from "@openllmsh/protocol";
import { readClaudeHistory } from "../local-sessions/claude";
import { setAgentStreamHandler } from "../mux-host";
import { createClaudeCodeAdapter } from "./claude-code";
import type { TAgentDispatcher } from "./dispatcher";
import { createAgentDispatcher } from "./dispatcher";
import { createAgentStreamHandler } from "./mux-front";

let dispatcher: TAgentDispatcher | null = null;

/** History rows scanned to find a resumed session's directory. */
const RESUME_LOOKUP_LIMIT = 500;

const resumeCwdOf = (
  engine: TAgentEngine,
  sessionId: string,
): string | undefined => {
  if (engine !== "claude") return undefined;
  try {
    return (
      readClaudeHistory(RESUME_LOOKUP_LIMIT).find((row) => row.id === sessionId)
        ?.cwd ?? undefined
    );
  } catch {
    return undefined;
  }
};

/** The running dispatcher, or null before {@link startAgentSessions}. */
export const activeAgentDispatcher = (): TAgentDispatcher | null => dispatcher;

/**
 * Create the dispatcher and register the mux `kind:"agent"` handler. Must run
 * before the relay `hello` so its caps already carry `agent1`. Idempotent.
 */
export const startAgentSessions = (): TAgentDispatcher => {
  if (dispatcher !== null) return dispatcher;
  const created = createAgentDispatcher({
    adapters: [createClaudeCodeAdapter()],
    resumeCwdOf,
  });
  dispatcher = created;
  setAgentStreamHandler(createAgentStreamHandler(created));
  return created;
};

/** Unregister and kill every agent session (shutdown, tests). */
export const stopAgentSessions = (): void => {
  setAgentStreamHandler(null);
  dispatcher?.closeAll();
  dispatcher = null;
};
