// Antigravity thinking effort. The catalog holds ONE card per model family
// (`antigravity/gemini-4-carbon`); `agy` serves it as `<stem>-<effort>` ids.
// The request's effort (the user's `min_reasoning_effort` floor is already
// applied to it) decides which id is pinned.

/** Ascending order; `none`/`minimal` rank below every served level and `max`
 *  above, so they clamp to the lowest / highest. */
const RANK: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

const rankOf = (effort: string): number => RANK[effort] ?? RANK.medium ?? 3;

const ascending = (levels: ReadonlyArray<string>): string[] =>
  [...new Set(levels)].sort((a, b) => rankOf(a) - rankOf(b));

/**
 * The served level for a request: the request's effort clamped to the nearest
 * served one (a tie goes up), or — with no effort asked — `medium`, else the
 * family's middle level. Null when the family has no levels.
 */
export const antigravityEffortOf = (
  requested: string | null | undefined,
  levels: ReadonlyArray<string>,
): string | null => {
  const served = ascending(levels);
  if (served.length === 0) return null;
  if (requested === undefined || requested === null || requested === "") {
    return served.includes("medium")
      ? "medium"
      : (served[Math.floor(served.length / 2)] ?? null);
  }
  const want = rankOf(requested);
  let best = served[0] ?? null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of served) {
    const distance = Math.abs(rankOf(level) - want);
    // Ascending order + `<=` means an equally near higher level wins.
    if (distance <= bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * The exact `agy` id for a family stem at the request's effort, from the
 * catalog's served levels. A stem with no catalog levels is served verbatim.
 */
export const antigravityPinnedId = (
  stem: string,
  requested: string | null | undefined,
  levels: ReadonlyArray<string> | undefined,
): string => {
  if (levels === undefined || levels.length === 0) return stem;
  const effort = antigravityEffortOf(requested, levels);
  return effort === null ? stem : `${stem}-${effort}`;
};

/**
 * Without the catalog's levels: the ids `agy` itself lists for this stem
 * (`<stem>-<effort>`), resolved the same way. Null when it lists none, i.e.
 * the stem is an id served verbatim.
 */
export const antigravityPinnedFromAvailable = (
  stem: string,
  requested: string | null | undefined,
  available: ReadonlyArray<string>,
): string | null => {
  const prefix = `${stem}-`;
  const levels = available.flatMap((id) => {
    const level = id.startsWith(prefix) ? id.slice(prefix.length) : "";
    return level in RANK &&
      level !== "none" &&
      level !== "minimal" &&
      level !== "max"
      ? [level]
      : [];
  });
  const effort = antigravityEffortOf(requested, levels);
  return effort === null ? null : `${prefix}${effort}`;
};
