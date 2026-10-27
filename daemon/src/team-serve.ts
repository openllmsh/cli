/**
 * Local team-serving kill switch. `OPENLLM_TEAM_SERVE=0` / `false` / `off` /
 * `no` refuses all team traffic and drops the `team_serve` capability; absent
 * or any other value leaves serving on. Dependency-free so bootstrap and the
 * admit path read the same rule.
 */
export const teamServeEnabled = (): boolean => {
  const raw = process.env.OPENLLM_TEAM_SERVE;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
};
