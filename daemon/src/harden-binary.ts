/**
 * macOS binary hardening — shared by the service registrar (`service.ts`) and
 * self-update. (The setup installer does its own `codesign` in shell.)
 *
 * The released (and especially cross-compiled) binaries are unnotarized and
 * not even ad-hoc signed, so on Apple Silicon the kernel SIGKILLs the Mach-O
 * the instant launchd spawns it ("didn't stay running"). Strip the Gatekeeper
 * quarantine xattr and ad-hoc sign locally — but ONLY when the existing
 * signature is missing/invalid, so a future real (notarized) signature is
 * preserved. No-op off darwin. Best-effort: never throws into the caller.
 */
import { execFileSync } from "node:child_process";
import { logWarn } from "./logger";

export const hardenMacBinary = (path: string): void => {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("xattr", ["-dr", "com.apple.quarantine", path], {
      stdio: "ignore",
    });
  } catch {
    // no quarantine xattr / xattr unavailable — fine
  }
  try {
    // NOTE: `codesign --verify` takes NO `--quiet` flag — macOS 15 rejects it
    // ("unrecognized option '--quiet'", rc=2). Passing it made `--verify`
    // always throw → the binary was treated as unsigned and re-signed on every
    // start/self-update, defeating the "preserve a valid signature" intent.
    // `stdio: "ignore"` already suppresses output.
    execFileSync("codesign", ["--verify", path], {
      stdio: "ignore",
    });
    return; // already validly signed — don't disturb it
  } catch {
    // not signed (or invalid) — ad-hoc sign below
  }
  try {
    execFileSync("codesign", ["--force", "--sign", "-", path], {
      stdio: "ignore",
    });
  } catch (err) {
    logWarn("harden", `could not codesign binary ${path}: ${String(err)}`);
  }
};
