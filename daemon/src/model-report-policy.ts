/**
 * Shared automatic model-discovery cadence. Leaf module — safe for
 * delegates / native-runtime to import without cycling through
 * `model-report.ts` → `DELEGATES`.
 *
 * The reporter (`maybeReportModels`) is the only due / single-flight /
 * stamp owner. Providers must not keep a second 30m timer; they may
 * read these windows if an extra RPC needs the same numbers.
 */
/** Local demand throttle — cloud read TTL is independent (stale-while-revalidate). */
export const MODEL_REPORT_TTL_MS = 30 * 60 * 1000;
/**
 * A failed live discovery retries on this slower cadence. Skips never
 * stamp a failure; a successful login resets the reporter throttle.
 */
export const MODEL_REPORT_FAILURE_RETRY_MS = 15 * 60 * 1000;
