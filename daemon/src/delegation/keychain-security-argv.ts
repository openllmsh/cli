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

/**
 * Flags that consume the following argv element as a value, per subcommand.
 * Used so a service/password that happens to contain `.keychain` cannot satisfy
 * the explicit-path rule (that would let `security` search the default list).
 */
const VALUE_TAKING_FLAGS: Readonly<
  Record<TAllowedSecuritySubcommand, ReadonlySet<string>>
> = {
  "create-keychain": new Set(["-p"]),
  "unlock-keychain": new Set(["-p"]),
  "set-keychain-settings": new Set(["-t"]),
  "show-keychain-info": new Set(),
  "dump-keychain": new Set(),
  "find-generic-password": new Set(["-a", "-s", "-c", "-D", "-G", "-l"]),
  "set-key-partition-list": new Set(["-S", "-k"]),
  "set-generic-password-partition-list": new Set(["-S", "-k", "-s", "-a"]),
};

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
  return name.endsWith(".keychain-db") || name.endsWith(".keychain");
};

/**
 * Last positional argv element after skipping flags and their values.
 * Production builders always place the keychain path last; a flag value that
 * merely looks like a keychain path is not a positional operand.
 */
const finalKeychainOperand = (
  argv: ReadonlyArray<string>,
  sub: TAllowedSecuritySubcommand,
): string | undefined => {
  const valueFlags = VALUE_TAKING_FLAGS[sub];
  let lastPositional: string | undefined;
  for (let i = 1; i < argv.length; ) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (isFlag(arg)) {
      const short = arg.length >= 2 ? arg.slice(0, 2) : arg;
      if (arg.length > 2 && !arg.startsWith("--") && valueFlags.has(short)) {
        // Glued `-pVALUE` / `-kVALUE`.
        i += 1;
        continue;
      }
      if (valueFlags.has(arg)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    lastPositional = arg;
    i += 1;
  }
  return lastPositional;
};

const hasExplicitKeychainPath = (
  argv: ReadonlyArray<string>,
  sub: TAllowedSecuritySubcommand,
): boolean => {
  const last = finalKeychainOperand(argv, sub);
  return last !== undefined && looksLikeKeychainPath(last);
};

const hasFlag = (
  argv: ReadonlyArray<string>,
  sub: TAllowedSecuritySubcommand,
  flag: string,
): boolean => {
  const valueFlags = VALUE_TAKING_FLAGS[sub];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!isFlag(arg)) continue; // positional or an already-skipped value
    if (arg === flag) return true;
    // `-pVALUE` / `-kVALUE` glued forms
    if (flag.length === 2 && arg.startsWith(flag) && arg.length > 2)
      return true;
    if (arg.startsWith(`${flag}=`)) return true;
    // Glued value-taking flag (`-pVALUE`) consumes no following token.
    const short = arg.length >= 2 ? arg.slice(0, 2) : arg;
    if (arg.length > 2 && !arg.startsWith("--") && valueFlags.has(short)) {
      continue;
    }
    if (valueFlags.has(arg)) i += 1; // skip this flag's value
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
  const allowedSub = sub as TAllowedSecuritySubcommand;

  if (
    REQUIRES_KEYCHAIN_PATH.has(allowedSub) &&
    !hasExplicitKeychainPath(argv, allowedSub)
  ) {
    throw new SecurityArgvRejectedError(
      `${allowedSub} requires an explicit keychain path`,
      argv,
    );
  }

  if (allowedSub === "create-keychain") {
    if (hasFlag(argv, allowedSub, "-P")) {
      throw new SecurityArgvRejectedError(
        "create-keychain must not use interactive -P",
        argv,
      );
    }
    if (!hasFlag(argv, allowedSub, "-p")) {
      throw new SecurityArgvRejectedError(
        "create-keychain requires non-interactive -p",
        argv,
      );
    }
  }

  if (allowedSub === "unlock-keychain") {
    if (!hasFlag(argv, allowedSub, "-p")) {
      throw new SecurityArgvRejectedError(
        "unlock-keychain requires non-interactive -p",
        argv,
      );
    }
  }

  if (
    allowedSub === "set-key-partition-list" ||
    allowedSub === "set-generic-password-partition-list"
  ) {
    if (!hasFlag(argv, allowedSub, "-k")) {
      throw new SecurityArgvRejectedError(
        `${allowedSub} requires non-interactive -k`,
        argv,
      );
    }
  }

  if (allowedSub === "dump-keychain") {
    const bad = hasForbiddenDumpFlag(argv);
    if (bad !== null) {
      throw new SecurityArgvRejectedError(
        `dump-keychain must not use ${bad}`,
        argv,
      );
    }
  }

  return allowedSub;
};
