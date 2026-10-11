/** Shared title truncation for local session readers. */

export const TITLE_MAX = 80;

const ELLIPSIS = "…";

export const truncate = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length === 0) return "Untitled";
  // Reserve the ellipsis width so the result never exceeds TITLE_MAX and
  // survives readLocalSessions' own `.slice(0, TITLE_MAX)` unchanged.
  return t.length <= TITLE_MAX
    ? t
    : `${t
        .slice(0, TITLE_MAX - ELLIPSIS.length)
        .replace(/[\uD800-\uDBFF]$/, "")}${ELLIPSIS}`;
};
