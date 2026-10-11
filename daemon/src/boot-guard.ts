/**
 * Crash-loop circuit breaker — the cross-platform half of the "cap on retry"
 * (the systemd native start-limit in `service.ts` is the Linux backstop;
 * launchd has no equivalent, so this is the only ceiling on macOS).
 *
 * The supervisor relaunches the daemon on EVERY exit (systemd `Restart=always`,
 * launchd `KeepAlive`). A persistent boot failure — port permanently in use, a
 * corrupt binary, a config the daemon rejects at startup — therefore respawns
 * forever: each boot re-runs the sandbox/FFI setup and writes log lines, so the
 * loop floods `openllmd.log` and pegs the CPU with nothing to show for it.
 *
 * `guardCrashLoop()` records each boot's timestamp in `state.json` and, if
 * too many boots land inside a short window, declares a crash loop: it disables
 * self-restore (so the supervisor stops relaunching) and exits cleanly. Recover
 * by fixing the cause and running `openllmd restart`. The decision is a pure
 * function (`shouldPark`) so the threshold is unit-testable without a real boot.
 *
 * Best-effort + never throws on its OWN I/O (mirrors `logger.ts`): if the
 * boot history can't be read/written the guard simply can't fire — the daemon
 * boots anyway and, on Linux, systemd's start-limit still bounds the churn.
 */
import { isDevMode } from "./env";
import { logError, logWarn } from "./logger";
import { serviceStop } from "./service";
import {
  clearRtcRun,
  evaluateRtcBreaker,
  mutateState,
  RTC_CRASH_LIMIT,
  RTC_CRASH_WINDOW_MS,
  readBootHistory,
  readState,
  writeBootHistory,
} from "./state-file";
import { DAEMON_VERSION } from "./version";

/** How far back a boot counts toward the crash-loop tally. */
export const CRASH_WINDOW_MS = 3 * 60 * 1000;
/** Boots within {@link CRASH_WINDOW_MS} that trip the breaker. ~10 boots in 3
 *  min ≈ one every 18s — well past any legitimate restart cadence (self-update
 *  is rare; the supervisor's backoff stretches a real crash loop to roughly this
 *  rate), but reached quickly once a boot fails persistently. */
export const CRASH_LIMIT = 10;

/**
 * Pure crash-loop decision. Appends `now` to the prior boot timestamps, drops
 * any that fell out of the window, and reports whether the surviving count has
 * reached the limit. Returns the trimmed list so the caller persists a bounded
 * history (it never grows without bound).
 */
export const shouldPark = (
  bootTimestamps: readonly number[],
  now: number,
): { recent: number[]; park: boolean } => {
  // `t <= now` drops future-dated entries: a clock rollback (or a corrupt
  // history) would otherwise make `now - t` negative — counted as in-window —
  // and could falsely park the daemon.
  const recent = [...bootTimestamps, now].filter(
    (t) => t <= now && now - t < CRASH_WINDOW_MS,
  );
  return { recent, park: recent.length >= CRASH_LIMIT };
};

/**
 * Record this boot and, if we've crash-looped, disable self-restore + exit so
 * the supervisor stops relaunching us. Call ONCE at the very start of boot,
 * before the sandbox + listener. Either returns (boot proceeds) or exits the
 * process (loop broken). As the first `state.json` reader each boot, this is
 * also what triggers the one-shot legacy-file migration (`state-file.ts`).
 */
export const guardCrashLoop = (): void => {
  // `bun --watch` dev daemons are unsupervised, so this breaker has no role
  // there and must never alter prod's shared history or installed service.
  if (isDevMode()) return;
  const now = Date.now();
  const { recent, park } = shouldPark(readBootHistory(), now);
  writeBootHistory(recent);
  if (!park) return;
  logError(
    "boot-guard",
    `crash loop detected — ${recent.length} restarts within ${Math.round(
      CRASH_WINDOW_MS / 1000,
    )}s. Disabling self-restore so it stops thrashing; fix the cause (see the error above) then run \`openllmd restart\`.`,
  );
  try {
    // Disable self-restore (launchctl disable+bootout / systemctl --user
    // disable --now) so the supervisor won't relaunch after we exit.
    serviceStop();
  } catch {
    // best-effort — even if disabling fails, exiting still clears this churn.
  }
  // Clear the window so the eventual `openllmd restart` starts from a clean
  // slate rather than re-tripping the guard on its first boot.
  writeBootHistory([]);
  process.exit(0);
};

/**
 * Clears crash-loop history after the daemon reaches a confirmed healthy boot.
 * Keeps transient failures from converting into a sticky parked state.
 */
export const markHealthyBoot = (): void => {
  if (isDevMode()) return;
  try {
    writeBootHistory([]);
  } catch {
    // best-effort + never throws
  }
};

/**
 * RTC native-crash circuit breaker — the boot wiring around the pure
 * {@link evaluateRtcBreaker} decision.
 *
 * The daemon can die to a Bun/werift native fault (SIGBUS/SIGSEGV) that no JS
 * handler can catch. If a host keeps doing it with RTC live, we withdraw RTC on
 * this host (`OPENLLM_RTC_DISABLE=1` → relay-mux, one hop slower but fully
 * working) rather than crash-loop. Call ONCE at boot, right after
 * {@link guardCrashLoop}. Detection is the liveness sentinel: this run writes
 * one and a `process.on("exit")` hook clears it on ANY graceful exit (normal,
 * the fatal-handler `process.exit`, SIGTERM via `finishShutdown`); a native
 * signal runs no hook, so a surviving sentinel next boot IS the crash signal.
 *
 * An operator who has EXPLICITLY set `OPENLLM_RTC_DISABLE` (either value) wins —
 * the breaker neither overrides their choice nor is fooled by it (the sentinel
 * records the effective state).
 */
export const guardRtcCircuitBreaker = (): void => {
  // Dev daemons are unsupervised and must not mutate prod's shared state.
  if (isDevMode()) return;
  const now = Date.now();
  const explicitOverride = process.env.OPENLLM_RTC_DISABLE !== undefined;
  const decision = evaluateRtcBreaker(
    readState(),
    now,
    DAEMON_VERSION,
    process.pid,
  );
  if (decision.disableRtc && !explicitOverride) {
    process.env.OPENLLM_RTC_DISABLE = "1";
    logWarn(
      "rtc-breaker",
      `RTC withdrawn: ${RTC_CRASH_LIMIT}+ native crashes with RTC live within ` +
        `${Math.round(RTC_CRASH_WINDOW_MS / 60000)}m. Falling back to relay-mux ` +
        `(one hop slower, fully functional). Auto-clears on the next daemon ` +
        `upgrade or once the crashes age out.`,
      { crashes: decision.nextState.rtcCrashes?.length ?? 0 },
    );
  }
  // Persist the tally + a sentinel that reflects the EFFECTIVE RTC state (honours
  // an operator override), so a native crash this run is attributed correctly.
  const rtcEnabled = process.env.OPENLLM_RTC_DISABLE !== "1";
  try {
    mutateState((s) => ({
      ...decision.nextState,
      // Re-read merge base for the non-RTC fields, but our decision owns the RTC
      // ones; override just the sentinel's effective flag.
      updateAttempts: s.updateAttempts,
      bootHistory: s.bootHistory,
      rtcRun: { pid: process.pid, startedAt: now, rtcEnabled },
    }));
  } catch {
    // best-effort — a persist failure just means the breaker can't arm; the
    // daemon boots anyway.
  }
  // Clear the sentinel on ANY graceful exit. Registered once per boot.
  process.on("exit", () => {
    try {
      clearRtcRun();
    } catch {
      // best-effort; a native signal wouldn't reach here anyway.
    }
  });
};
