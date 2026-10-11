/**
 * Shared env-map type for capture adapters' hermetic tests.
 *
 * Capture activation is the selected sub-method `bridge-capture` via
 * `ACTIVE_SUB_METHOD` → bootstrap → capability table. No separate flag.
 */

export type TEnvLike = Readonly<Record<string, string | undefined>>;
