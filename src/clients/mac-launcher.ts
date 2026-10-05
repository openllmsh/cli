/**
 * On-box Mac `.app` launcher builder for the always-on desktop-app clients
 * (`openllm chatgpt`). The bundle carries NO logic: its executable is a fixed
 * one-line shim that execs `openllm <client> launch`, so all behaviour lives in
 * the self-updating CLI and the bundle never needs rebuilding.
 *
 * Generated on the user's machine (no download → no quarantine). Unsigned is
 * fine; we `chmod +x`, `xattr -cr`, and best-effort ad-hoc `codesign`.
 * See docs/audit/2026-08-23-cowork-codex-mac-app-setups.md §9.1.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type TMacLauncherSpec = {
  /** Display name (`CFBundleName` / `CFBundleDisplayName`). */
  readonly displayName: string;
  /** Our bundle id — also the ownership marker checked before overwrite/removal. */
  readonly bundleId: string;
  /** Filename under `Contents/MacOS/` — must match `CFBundleExecutable`. */
  readonly executableName: string;
  /** Absolute argv the shim execs (`[<openllm-bin>, …args]`). */
  readonly command: readonly string[];
  /** Optional `.icns` to copy in so the launcher isn't a blank icon. */
  readonly iconPath?: string;
};

export const applicationsDir = (): string => {
  const override = process.env.OPENLLM_APPLICATIONS_DIR;
  return override !== undefined && override.length > 0
    ? override
    : "/Applications";
};

export const macLauncherPath = (appFileName: string): string =>
  join(applicationsDir(), appFileName);

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** POSIX single-quote a shell word. */
export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const ICON_FILE = "AppIcon.icns";

const plistXml = (
  spec: TMacLauncherSpec,
  hasIcon: boolean,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${escapeXml(spec.displayName)}</string>
  <key>CFBundleDisplayName</key>
  <string>${escapeXml(spec.displayName)}</string>
  <key>CFBundleIdentifier</key>
  <string>${escapeXml(spec.bundleId)}</string>
  <key>CFBundleExecutable</key>
  <string>${escapeXml(spec.executableName)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
${hasIcon ? `  <key>CFBundleIconFile</key>\n  <string>${ICON_FILE}</string>\n` : ""}  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;

/**
 * The launcher's executable. GUI apps have no `PATH` and nobody sees stderr,
 * so a missing CLI binary or a failed launch surfaces as a dialog rather than
 * a silent no-op. Not `exec`: we need the exit status to report it.
 */
export const launcherScript = (command: readonly string[]): string => {
  const bin = command[0] ?? "";
  return `#!/bin/sh
if [ ! -x ${shellQuote(bin)} ]; then
  /usr/bin/osascript -e 'display alert "OpenLLM CLI not found" message "Reinstall it with: curl -fsSL https://openllm.sh/install | bash"' >/dev/null 2>&1
  exit 1
fi
${command.map(shellQuote).join(" ")} >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  /usr/bin/osascript -e "display alert \\"OpenLLM could not start\\" message \\"Exit $status. Run this in Terminal for details: openllm ${command.slice(1).join(" ").replaceAll('"', "")}\\"" >/dev/null 2>&1
fi
exit "$status"
`;
};

/** The `CFBundleIdentifier` of the bundle at `appPath`, or null. */
export const bundleIdOf = (appPath: string): string | null => {
  try {
    const plist = readFileSync(
      join(appPath, "Contents", "Info.plist"),
      "utf-8",
    );
    const match =
      /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
};

/** The vendor app's `.icns`, per its `CFBundleIconFile`, when present. */
export const appIconPath = (appPath: string): string | undefined => {
  try {
    const plist = readFileSync(
      join(appPath, "Contents", "Info.plist"),
      "utf-8",
    );
    const match =
      /<key>CFBundleIconFile<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
    if (match?.[1] === undefined) return undefined;
    const name = match[1].endsWith(".icns") ? match[1] : `${match[1]}.icns`;
    const path = join(appPath, "Contents", "Resources", name);
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
};

export type TInstallLauncherResult = "installed" | "foreign";

/**
 * Write (or rewrite) the launcher bundle. Refuses with `"foreign"` when a
 * bundle we don't own already sits at `destApp` — never clobber a user app.
 */
export const installMacLauncher = (
  destApp: string,
  spec: TMacLauncherSpec,
): TInstallLauncherResult => {
  if (existsSync(destApp) && bundleIdOf(destApp) !== spec.bundleId) {
    return "foreign";
  }
  rmSync(destApp, { recursive: true, force: true });
  const contents = join(destApp, "Contents");
  const macOs = join(contents, "MacOS");
  mkdirSync(macOs, { recursive: true });
  let hasIcon = false;
  if (spec.iconPath !== undefined) {
    try {
      mkdirSync(join(contents, "Resources"), { recursive: true });
      copyFileSync(spec.iconPath, join(contents, "Resources", ICON_FILE));
      hasIcon = true;
    } catch {
      // Cosmetic only.
    }
  }
  writeFileSync(join(contents, "Info.plist"), plistXml(spec, hasIcon), {
    mode: 0o644,
  });
  const execPath = join(macOs, spec.executableName);
  writeFileSync(execPath, launcherScript(spec.command), { mode: 0o755 });
  chmodSync(execPath, 0o755);
  if (process.platform === "darwin") {
    try {
      execFileSync("xattr", ["-cr", destApp], { stdio: "ignore" });
    } catch {
      // On-box bundles carry no quarantine; a missing xattr is fine.
    }
    try {
      execFileSync("codesign", ["-s", "-", "--force", "--deep", destApp], {
        stdio: "ignore",
      });
    } catch {
      // Ad-hoc sign is best-effort (CI / locked-down hosts).
    }
  }
  return "installed";
};

/** Remove the launcher only when it is ours. True when something was removed. */
export const uninstallMacLauncher = (
  destApp: string,
  bundleId: string,
): boolean => {
  if (!existsSync(destApp) || bundleIdOf(destApp) !== bundleId) return false;
  rmSync(destApp, { recursive: true, force: true });
  return true;
};
