/**
 * Request-private ephemeral `CODEX_HOME` for the Codex bridge-capture
 * redirect keys (`chatgpt_base_url` / `openai_base_url`).
 *
 * Each capture invocation gets its OWN, brand-new, never-shared,
 * never-reused `CODEX_HOME` (mode `0700`, deleted after the child exits)
 * containing only:
 *   - `config.toml` (mode `0600`) — the two redirect keys plus a pinned
 *     `cli_auth_credentials_store = "file"` (see "auth-storage contract"
 *     below). Nothing pre-existing to back up/restore.
 *   - `auth.json` — a SYMLINK to the durable install's real credential file
 *     (never a copy). No other durable file (sessions, thread history,
 *     `installation_id`, cache, logs) is replicated — only `auth.json` is
 *     required for the app-server to authenticate.
 * Because this directory is never shared with any other process, there is
 * nothing to lock: two overlapping captures get two independent homes, and a
 * crash orphans at most one throwaway directory that no other process reads.
 * The durable `CODEX_HOME` is never opened for writing, backed up, or
 * modified by this module.
 *
 * SOURCE: openai/codex rust-v0.156.0 (`codex-rs`).
 *   - `AuthCredentialsStoreMode` (`config/src/types.rs`, `#[default] File`)
 *     read from `cli_auth_credentials_store` (`config/src/config_toml.rs`,
 *     field `cli_auth_credentials_store`).
 *   - `AuthDotJson::storage_mode()` / `resolved_mode()`
 *     (`login/src/auth/manager.rs`).
 *   - Keyring/ephemeral backends key by a hash of the CANONICALIZED
 *     `CODEX_HOME` path (`compute_store_key`, `login/src/auth/storage.rs`);
 *     `AutoAuthStorage::save()` tries keyring first and only falls back to
 *     file on an error, not on a path/key mismatch — so keyring or auto mode
 *     would let a mid-capture refresh succeed against the WRONG (ephemeral)
 *     key, orphaned from the durable identity. `assertEphemeralHomeAuthStorageIsSafe`
 *     fails closed against that entire class, not just the two variants that
 *     provoked the discovery.
 *   - `FileAuthStorage::save()`/`delete_file_if_exists()`
 *     (`login/src/auth/storage.rs`) use `OpenOptions::open()` (in-place
 *     truncate+write) and `std::fs::remove_file()` (`unlink()`) respectively
 *     — both follow/act on the path, not a cached inode, so a symlinked
 *     `auth.json` receives reads, refresh writes, and delete correctly
 *     without ever being copied or replaced.
 *   - No cross-process file lock exists around `auth.json` in upstream
 *     codex-rs (only an in-process `Mutex`); this module does not change
 *     that pre-existing multi-process characteristic.
 *
 * AUTH-STORAGE CONTRACT (why a scan AND a pinned key, not just one):
 * `assertEphemeralHomeAuthStorageIsSafe` parses the durable `config.toml`
 * with `Bun.TOML.parse` and fails closed unless `cli_auth_credentials_store`
 * is absent or exactly `"file"` — ANY other explicit value (`keyring`,
 * `auto`, `ephemeral`, or an unrecognized future variant) is treated as
 * unsafe, not an allowlist of the two variants known today. A read error
 * other than "file does not exist" (ENOENT) — permission denied, an I/O
 * error, malformed TOML — also fails closed; it never silently falls
 * through to "safe". Independently, the ephemeral `config.toml` this module
 * writes ALSO pins `cli_auth_credentials_store = "file"` explicitly: config
 * layer precedence is package → admin → system → cloud → user → profile →
 * cwd → tree → repo → runtime, so the durable install's own `config.toml`
 * (the `user` layer) can only ever be read from the checked path — but a
 * system- or cloud-managed layer (`/etc/codex/config.toml` or an MDM/managed
 * bundle) sits BELOW `user` in precedence and is never inspected by the scan
 * above. Pinning the key in our own (higher-precedence) ephemeral `config.toml`
 * neutralizes that gap directly, rather than trying to enumerate every layer
 * that could set it.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type TCodexCaptureEphemeralHomeHandle = {
  readonly ephemeralHome: string;
  readonly durableCodexHome: string;
  /** Best-effort `rm -rf` of the ephemeral directory ONLY — never touches
   *  `durableCodexHome` or anything inside it. Safe to call more than once. */
  readonly cleanup: () => Promise<void>;
};

/** TOML string escaping for a URL value. */
const tomlString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * True when a parsed durable `config.toml` explicitly selects an auth
 * storage backend other than `file`. Treats the key as unsafe unless its
 * value is the string `"file"` exactly — this is a denylist of everything
 * BUT `file`, not an allowlist of `keyring`/`auto` alone, so an
 * `"ephemeral"` value or any future/unrecognized variant is caught too.
 * Absence of the key (parses to `undefined`) is safe (the real `File`
 * default). A non-string value is treated as unsafe (malformed input should
 * never be interpreted as safe).
 */
export const isUnsafeAuthStorageMode = (
  parsedConfigToml: Record<string, unknown>,
): boolean => {
  if (!("cli_auth_credentials_store" in parsedConfigToml)) return false;
  const value = parsedConfigToml.cli_auth_credentials_store;
  return typeof value !== "string" || value.toLowerCase() !== "file";
};

/**
 * Fails closed (throws) when the durable install's OWN config has opted into
 * a storage backend this module cannot safely redirect around (see the
 * module doc comment's "auth-storage contract"). Never reads or logs
 * `auth.json` contents — only parses the durable `config.toml`'s
 * `cli_auth_credentials_store` key. A missing file (ENOENT) is the safe
 * default; a permission error, any other I/O error, or malformed TOML all
 * fail closed rather than being treated as "no override present".
 */
export const assertEphemeralHomeAuthStorageIsSafe = async (
  durableCodexHome: string,
): Promise<void> => {
  const durableConfigPath = join(durableCodexHome, "config.toml");
  let contents: string;
  try {
    contents = await readFile(durableConfigPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      // No durable config.toml at all → the real `File` default applies.
      return;
    }
    // Anything else (EACCES, EISDIR, a transient I/O error, …) fails closed
    // — never silently treated as "no override present".
    throw new Error(
      `codex capture: could not read durable config.toml to verify auth-storage mode (${code ?? "unknown error"}); refusing to build an ephemeral CODEX_HOME without that check`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(contents) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `codex capture: durable config.toml is not valid TOML (${err instanceof Error ? err.message : String(err)}); refusing to build an ephemeral CODEX_HOME without a verified auth-storage mode`,
    );
  }

  if (isUnsafeAuthStorageMode(parsed)) {
    throw new Error(
      "codex capture: durable config.toml selects a non-file " +
        "cli_auth_credentials_store — an ephemeral CODEX_HOME cannot safely " +
        "redirect a token refresh in that mode (keyring/auto/ephemeral all " +
        "key or store by CODEX_HOME path/process, see module doc comment); " +
        "refusing rather than risk orphaning a refreshed credential",
    );
  }
};

/**
 * Builds a fresh, request-private `CODEX_HOME` for one capture invocation:
 * mode `0700` directory, mode `0600` `config.toml` carrying the two redirect
 * keys plus a pinned `cli_auth_credentials_store = "file"`, and `auth.json`
 * symlinked (never copied) to the durable install's real credential file.
 * Fails closed (throws, nothing left on disk) if the durable auth-storage
 * mode is unsafe to redirect or the durable `auth.json` does not exist
 * (nothing to symlink — there is no safe fallback that still lets the real
 * app-server authenticate).
 */
export const createCodexCaptureEphemeralHome = async (args: {
  readonly durableCodexHome: string;
  readonly chatgptBaseUrl: string;
  readonly openaiBaseUrl: string;
  /** Parent directory for ephemeral homes — the daemon's own granted temp
   *  space (e.g. `join(daemonTempDir(), "codex-capture-home")`). Created if
   *  missing. */
  readonly tempRoot: string;
}): Promise<TCodexCaptureEphemeralHomeHandle> => {
  await assertEphemeralHomeAuthStorageIsSafe(args.durableCodexHome);

  const durableAuthPath = join(args.durableCodexHome, "auth.json");
  if (!existsSync(durableAuthPath)) {
    throw new Error(
      "codex capture: durable auth.json missing — refusing to build an " +
        "ephemeral CODEX_HOME with nothing to symlink (not logged in?)",
    );
  }

  await mkdir(args.tempRoot, { recursive: true, mode: 0o700 });
  const ephemeralHome = join(
    args.tempRoot,
    `capture-${randomBytes(9).toString("hex")}`,
  );
  await mkdir(ephemeralHome, { recursive: false, mode: 0o700 });

  let created = false;
  try {
    await symlink(durableAuthPath, join(ephemeralHome, "auth.json"));
    const configContents = [
      `chatgpt_base_url = ${tomlString(args.chatgptBaseUrl)}`,
      `openai_base_url = ${tomlString(args.openaiBaseUrl)}`,
      // Pinned even though the durable config was already verified safe —
      // this ephemeral `config.toml` IS the `user` layer for the spawned
      // child, which outranks any system/cloud/managed layer in precedence
      // (see the module doc comment's "auth-storage contract"), so pinning
      // it here closes that gap directly rather than requiring the scan to
      // enumerate every lower-precedence layer that could set it.
      `cli_auth_credentials_store = "file"`,
      "",
    ].join("\n");
    await writeFile(join(ephemeralHome, "config.toml"), configContents, {
      mode: 0o600,
    });
    created = true;
  } finally {
    if (!created) {
      // Setup failed partway through — never leave a half-built ephemeral
      // home (and its auth.json symlink) on disk.
      await rm(ephemeralHome, { recursive: true, force: true }).catch(() => {
        // best-effort
      });
    }
  }

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    // ONLY the ephemeral directory — never `args.durableCodexHome`. `rm`
    // on the ephemeral `auth.json` symlink entry removes the symlink itself
    // (POSIX `unlink()`), never the durable target it points to.
    await rm(ephemeralHome, { recursive: true, force: true }).catch(() => {
      // best-effort — dispose paths run under process teardown races too.
    });
  };

  return {
    ephemeralHome,
    durableCodexHome: args.durableCodexHome,
    cleanup,
  };
};

/** Test-only: read back the ephemeral overlay's raw `config.toml` contents. */
export const readCodexCaptureEphemeralHomeConfigForTest = async (
  ephemeralHome: string,
): Promise<string | null> => {
  try {
    return await readFile(join(ephemeralHome, "config.toml"), "utf8");
  } catch {
    return null;
  }
};
