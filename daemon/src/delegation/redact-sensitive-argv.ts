/** Secret-bearing option VALUES (`-p`/`-w`/`-k`) redacted for logs.
 *  `-w` carries the OAuth credential payload (`add-generic-password`),
 *  `-p` a keychain password, `-k` the partition-list unlock password —
 *  none may reach `openllmd.err.log`. Unsupported long options are left
 *  as-is: neither `runCapture` nor `security` callers pass them. */
export const redactSensitiveArgv = (argv: ReadonlyArray<string>): string[] =>
  argv.map((arg, i) =>
    i > 0 &&
    (argv[i - 1] === "-w" || argv[i - 1] === "-p" || argv[i - 1] === "-k")
      ? "<redacted>"
      : arg,
  );
