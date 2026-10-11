import { isDevMode } from "../env";

/**
 * Dev/prod-aware prefix for re-execing THIS daemon's own entrypoint, so a
 * supervised wrapper runs the SAME code. Dev re-execs the source runner
 * (`[bun, script]`); a compiled run re-execs the running binary — the single
 * `openllm` binary routes the internal flags straight to the daemon, whatever
 * name (`openllm` / legacy `openllmd`) it was launched under. The subcommand
 * always lands at args[0].
 */
export const daemonSelfInvocation = (): readonly string[] => {
  const sourceRunner = process.argv[1];
  if (isDevMode() && sourceRunner !== undefined)
    return [process.execPath, sourceRunner];
  return [process.execPath];
};
