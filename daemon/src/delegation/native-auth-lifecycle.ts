import type {
  TDoctorAuthOperationKind,
  TDoctorAuthPhase,
  TDoctorOutcomeLedger,
  TSubscriptionProviderSlug,
} from "@openllmsh/protocol";
import { projectDoctorOutcomeLedger } from "@openllmsh/protocol";
import { opaqueDoctorCorrelation } from "../doctor-report/correlation";
import { logInfo, safeDiagnosticMessage } from "../logger";
import type { TNativeAuthProducer } from "./spawn";

/** Same closed set as protocol `DoctorAuthPhase`. */
export type TNativeAuthLifecyclePhase = TDoctorAuthPhase;

export type TNativeAuthLifecycleConfig = {
  readonly scope: string;
  readonly producer: TNativeAuthProducer;
  readonly operationId?: string;
  readonly provider?: TSubscriptionProviderSlug;
};

/** Bounded per-attempt logging; independent of doctor-report batching. */
const MAX_STAGE_RECORDS = 32;

const STAGE_MESSAGE: Record<
  TNativeAuthLifecyclePhase,
  ReturnType<typeof safeDiagnosticMessage>
> = {
  readiness_wait: safeDiagnosticMessage`Native authentication readiness waiting.`,
  readiness: safeDiagnosticMessage`Native authentication readiness completed.`,
  start: safeDiagnosticMessage`Native authentication started.`,
  child_wait: safeDiagnosticMessage`Native authentication child waiting.`,
  child: safeDiagnosticMessage`Native authentication child completed.`,
  prompt: safeDiagnosticMessage`Native authentication prompt surfaced.`,
  prep_wait: safeDiagnosticMessage`Native authentication preparation waiting.`,
  prep: safeDiagnosticMessage`Native authentication preparation completed.`,
  verify_wait: safeDiagnosticMessage`Native authentication verification waiting.`,
  verify: safeDiagnosticMessage`Native authentication verification completed.`,
  terminal: safeDiagnosticMessage`Native authentication attempt finished.`,
};

const operationKindFromProducer = (
  producer: TNativeAuthProducer,
): TDoctorAuthOperationKind | undefined => {
  if (producer === "claude-login" || producer === "stream-login") {
    return "login";
  }
  if (producer === "claude-logout") return "logout";
  if (producer === "claude-auth-status") return "status_probe";
  return undefined;
};

/**
 * Bounded per-attempt stage recorder. Info stages never throw.
 * Durations are `performance.now()` deltas on both local meta and doctor timings.
 */
export type TNativeAuthLifecycleTimings = {
  readonly spawn_setup_ms?: number;
  readonly child_wait_ms?: number;
  readonly cleanup_ms?: number;
  /** Child exit status when it exited before the expected stage. */
  readonly root_exit_code?: number;
} & TDoctorOutcomeLedger;

export const createNativeAuthLifecycle = (
  cfg: TNativeAuthLifecycleConfig,
): {
  readonly mark: () => number;
  readonly record: (
    phase: TNativeAuthLifecyclePhase,
    startedAtMs?: number,
    extras?: TNativeAuthLifecycleTimings,
  ) => void;
} => {
  const attemptStartedAtMs = performance.now();
  let remaining = MAX_STAGE_RECORDS;
  const correlation_id = opaqueDoctorCorrelation(cfg.operationId);
  const operation_kind = operationKindFromProducer(cfg.producer);
  return {
    mark: (): number => performance.now(),
    record: (phase, startedAtMs, extras): void => {
      if (remaining <= 0) return;
      remaining -= 1;
      const elapsed_ms = Math.max(
        0,
        performance.now() - (startedAtMs ?? attemptStartedAtMs),
      );
      try {
        const ledger = projectDoctorOutcomeLedger({
          ...(cfg.provider !== undefined ? { provider: cfg.provider } : {}),
          ...(operation_kind !== undefined ? { operation_kind } : {}),
          phase,
          ...(extras ?? {}),
        });
        logInfo(
          cfg.scope,
          STAGE_MESSAGE[phase],
          {
            producer: cfg.producer,
            phase,
            clock: "performance.now",
            elapsed_ms,
            ...(extras?.spawn_setup_ms !== undefined
              ? { spawn_setup_ms: extras.spawn_setup_ms }
              : {}),
            ...(extras?.child_wait_ms !== undefined
              ? { child_wait_ms: extras.child_wait_ms }
              : {}),
            ...(extras?.cleanup_ms !== undefined
              ? { cleanup_ms: extras.cleanup_ms }
              : {}),
            ...(correlation_id !== undefined
              ? { operation_id: correlation_id }
              : {}),
          },
          {
            timings: {
              elapsed_ms,
              ...(extras?.spawn_setup_ms !== undefined
                ? { spawn_setup_ms: extras.spawn_setup_ms }
                : {}),
              ...(extras?.cleanup_ms !== undefined
                ? { cleanup_ms: extras.cleanup_ms }
                : {}),
              ...(extras?.root_exit_code !== undefined
                ? { root_exit_code: extras.root_exit_code }
                : {}),
            },
            ...(correlation_id !== undefined ? { correlation_id } : {}),
            ...ledger,
          },
        );
      } catch {
        // Reporting must never change login/logout outcome.
      }
    },
  };
};
