/**
 * Pure argv policy for every OpenLLM-issued `security` spawn.
 *
 * Structural no-prompt guarantee: anything that can raise a SecurityAgent UI
 * (interactive create, decrypting dump, session search-list mutation, or a
 * keychain op without an explicit path) is rejected BEFORE spawn. Callers never
 * see a prompt from a policy violation — they see {@link SecurityArgvRejectedError}.
 */
import { basename } from "node:path";

/** Subcommands OpenLLM is allowed to issue. Everything else is rejected. */
export const ALLOWED_SECURITY_SUBCOMMANDS = [
  "create-keychain",
  "unlock-keychain",
  "set-keychain-settings",
  "show-keychain-info",
  "dump-keychain",
  "find-generic-password",
  "set-key-partition-list",
  "set-generic-password-partition-list",
] as const;

export type TAllowedSecuritySubcommand =
  (typeof ALLOWED_SECURITY_SUBCOMMANDS)[number];

const ALLOWED = new Set<string>(ALLOWED_SECURITY_SUBCOMMANDS);

/** Subcommands that operate on a keychain file and MUST name it explicitly. */
const REQUIRES_KEYCHAIN_PATH = new Set<string>(ALLOWED_SECURITY_SUBCOMMANDS);

/** Rejected dump-keychain flags (decrypt / ACL dump / interactive ACL edit). */
const FORBIDDEN_DUMP_FLAGS = new Set(["-d", "-a", "-i"]);

export class SecurityArgvRejectedError extends Error {
  readonly code = "security_argv_rejected" as const;
  readonly reason: string;
  readonly argv: ReadonlyArray<string>;

  constructor(reason: string, argv: ReadonlyArray<string>) {
    super(`security argv rejected: ${reason}`);
    this.name = "SecurityArgvRejectedError";
    this.reason = reason;
    this.argv = argv;
  }
}

const isFlag = (arg: string): boolean => arg.startsWith("-");

/** A keychain operand: ends with a known keychain suffix, never a flag. */
export const looksLikeKeychainPath = (arg: string): boolean => {
  if (arg.length === 0 || isFlag(arg)) return false;
  const name = basename(arg).toLowerCase();
  return (
    name.endsWith(".keychain-db") ||
    name.endsWith(".keychain") ||
    name.includes(".keychain-db") ||
    name.includes(".keychain")
  );
};

const hasExplicitKeychainPath = (argv: ReadonlyArray<string>): boolean =>
  argv.some(looksLikeKeychainPath);

const hasFlag = (argv: ReadonlyArray<string>, flag: string): boolean => {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === flag) return true;
    // `-pVALUE` / `-kVALUE` glued forms
    if (flag.length === 2 && arg.startsWith(flag) && arg.length > 2)
      return true;
    if (arg.startsWith(`${flag}=`)) return true;
  }
  return false;
};

const hasForbiddenDumpFlag = (argv: ReadonlyArray<string>): string | null => {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (FORBIDDEN_DUMP_FLAGS.has(arg)) return arg;
    // Glued short flags are not used by `security`, but reject `-d…` defensively.
    if (arg.length > 2 && arg.startsWith("-") && !arg.startsWith("--")) {
      for (const ch of arg.slice(1)) {
        const flag = `-${ch}`;
        if (FORBIDDEN_DUMP_FLAGS.has(flag)) return flag;
      }
    }
  }
  return null;
};

/**
 * Validate a `security` argv (subcommand first — the leading `security` binary
 * is NOT included; that is added by the spawner). Throws
 * {@link SecurityArgvRejectedError} on violation; returns the subcommand on ok.
 */
export const assertSafeSecurityArgv = (
  argv: ReadonlyArray<string>,
): TAllowedSecuritySubcommand => {
  const sub = argv[0];
  if (sub === undefined || sub.length === 0) {
    throw new SecurityArgvRejectedError("missing subcommand", argv);
  }
  if (isFlag(sub) || !ALLOWED.has(sub)) {
    throw new SecurityArgvRejectedError(
      `subcommand not allowlisted: ${sub}`,
      argv,
    );
  }

  if (REQUIRES_KEYCHAIN_PATH.has(sub) && !hasExplicitKeychainPath(argv)) {
    throw new SecurityArgvRejectedError(
      `${sub} requires an explicit keychain path`,
      argv,
    );
  }

  if (sub === "create-keychain") {
    if (hasFlag(argv, "-P")) {
      throw new SecurityArgvRejectedError(
        "create-keychain must not use interactive -P",
        argv,
      );
    }
    if (!hasFlag(argv, "-p")) {
      throw new SecurityArgvRejectedError(
        "create-keychain requires non-interactive -p",
        argv,
      );
    }
  }

  if (sub === "unlock-keychain") {
    if (!hasFlag(argv, "-p")) {
      throw new SecurityArgvRejectedError(
        "unlock-keychain requires non-interactive -p",
        argv,
      );
    }
  }

  if (
    sub === "set-key-partition-list" ||
    sub === "set-generic-password-partition-list"
  ) {
    if (!hasFlag(argv, "-k")) {
      throw new SecurityArgvRejectedError(
        `${sub} requires non-interactive -k`,
        argv,
      );
    }
  }

  if (sub === "dump-keychain") {
    const bad = hasForbiddenDumpFlag(argv);
    if (bad !== null) {
      throw new SecurityArgvRejectedError(
        `dump-keychain must not use ${bad}`,
        argv,
      );
    }
  }

  return sub as TAllowedSecuritySubcommand;
};
