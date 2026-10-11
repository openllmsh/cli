import { logError } from "../logger";
import { terminateAllDisposable } from "./supervisor";

const DISPOSABLE_DRAIN_TIMEOUT_MS = 5_000;

/** Best-effort bounded cleanup before the daemon exits or replaces itself. */
export const drainDisposableChildren = async (): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      terminateAllDisposable(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DISPOSABLE_DRAIN_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logError("child-supervisor", error);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};
