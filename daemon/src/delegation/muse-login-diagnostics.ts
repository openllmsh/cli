/**
 * Privacy-safe Muse native-login exit diagnostics.
 *
 * Used when `muse login` prints an authorize URL then exits before a verified
 * credential lands (the shared `finishInBackground` `cli_crash` path). Codes /
 * categories only — never raw auth URLs, device codes, tokens, or full stderr.
 */

export type TMuseLoginExitCategory =
  | "reaped"
  | "zero_exit"
  | "nonzero_exit"
  | "signal_or_unknown";

export type TMuseLoginStderrCategory =
  | "muse_login_stderr_empty"
  | "muse_login_stderr_permission"
  | "muse_login_stderr_sandbox"
  | "muse_login_stderr_auth"
  | "muse_login_stderr_payment"
  | "muse_login_stderr_network"
  | "muse_login_stderr_other";

export type TMuseLoginBackgroundExitInfo = {
  readonly exitCode: number | null;
  readonly captured: string;
  readonly reaped: boolean;
};

export type TMuseLoginBackgroundExitDiagnostic = {
  readonly exitCode: number | null;
  readonly exitCategory: TMuseLoginExitCategory;
  readonly stderrCategory: TMuseLoginStderrCategory;
  readonly capturedBytes: number;
};

const CAPTURE_BYTES_CAP = 4_096;

/**
 * Fixed public copy for the live Muse billing gate. Whitelist only — never echo
 * the vendor URL / subscribe link / raw stderr into the dashboard.
 */
export const MUSE_LOGIN_PAYMENT_REQUIRED_DETAIL =
  "Muse Code requires a payment method. Complete billing/subscription setup for the Meta account you signed in with, then try again.";

/**
 * Live Muse stderr (URL optional, before or after the phrase):
 * `Muse Code requires a payment method — subscribe at <URL> then log in again.`
 */
const MUSE_PAYMENT_REQUIRED_RE = /Muse Code requires a payment method/i;

/**
 * Map a Muse login capture onto a privacy-safe public detail, or `null` when the
 * capture is not a known whitelist failure (caller keeps the path-default
 * generic message).
 */
export const mapMuseLoginCrashDetail = (captured: string): string | null => {
  if (MUSE_PAYMENT_REQUIRED_RE.test(captured.slice(0, CAPTURE_BYTES_CAP))) {
    return MUSE_LOGIN_PAYMENT_REQUIRED_DETAIL;
  }
  return null;
};

/**
 * Classify a Muse login background exit for logs / crashDetail titles.
 * Input may contain secrets — only length + category leave this function.
 */
export const classifyMuseLoginBackgroundExit = (
  info: TMuseLoginBackgroundExitInfo,
): TMuseLoginBackgroundExitDiagnostic => {
  const captured = info.captured.slice(0, CAPTURE_BYTES_CAP);
  const capturedBytes = captured.length;
  const exitCategory: TMuseLoginExitCategory = info.reaped
    ? "reaped"
    : typeof info.exitCode !== "number"
      ? "signal_or_unknown"
      : info.exitCode === 0
        ? "zero_exit"
        : "nonzero_exit";

  const text = captured.trim();
  let stderrCategory: TMuseLoginStderrCategory = "muse_login_stderr_empty";
  if (text.length > 0) {
    // Sandbox markers first — seatbelt/posix_spawn lines often include
    // "Operation not permitted", which must not collapse into a generic
    // filesystem-permission category.
    if (/posix_spawn|sandbox-exec|seatbelt|landlock|\bsandbox\b/i.test(text)) {
      stderrCategory = "muse_login_stderr_sandbox";
    } else if (MUSE_PAYMENT_REQUIRED_RE.test(text)) {
      stderrCategory = "muse_login_stderr_payment";
    } else if (
      /EACCES|EPERM|permission denied|operation not permitted|read-only file system/i.test(
        text,
      )
    ) {
      stderrCategory = "muse_login_stderr_permission";
    } else if (
      /unauthorized|unauthenticated|auth(?:entication)? failed|not signed in|credential|keychain/i.test(
        text,
      )
    ) {
      stderrCategory = "muse_login_stderr_auth";
    } else if (/ECONN|ENOTFOUND|ETIMEDOUT|socket hang up|network/i.test(text)) {
      stderrCategory = "muse_login_stderr_network";
    } else {
      stderrCategory = "muse_login_stderr_other";
    }
  }

  return {
    exitCode: info.exitCode,
    exitCategory,
    stderrCategory,
    capturedBytes,
  };
};
