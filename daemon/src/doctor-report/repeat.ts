/** Local repeat suppression with a hard key cap. Not an event map. */
const COOLDOWN_MS = 60_000;
const MAX_KEYS = 32;

type TBucket = {
  count: number;
  lastAt: number;
};

const buckets = new Map<string, TBucket>();

const evictOldest = (): void => {
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, bucket] of buckets) {
    if (bucket.lastAt < oldestAt) {
      oldestAt = bucket.lastAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) buckets.delete(oldestKey);
};

/**
 * Count a repeat. Returns the accumulated count when a report may emit,
 * otherwise null while still inside the cooldown window.
 */
export const takeRepeatWindow = (
  key: string,
  now = Date.now(),
): number | null => {
  const prev = buckets.get(key);
  if (prev === undefined) {
    if (buckets.size >= MAX_KEYS) evictOldest();
    buckets.set(key, { count: 0, lastAt: now });
    return 1;
  }
  prev.count += 1;
  if (now - prev.lastAt < COOLDOWN_MS) return null;
  const n = prev.count;
  prev.lastAt = now;
  prev.count = 0;
  return n;
};

export const resetDoctorRepeatForTests = (): void => {
  buckets.clear();
};

export const doctorRepeatKeyCountForTests = (): number => buckets.size;
