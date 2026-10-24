/**
 * `openllmd` command-line dispatch.
 *
 * The same binary is BOTH the long-running daemon (run with no args by the
 * launch agent / systemd unit) AND a small management CLI. `runCli()` handles
 * the management subcommands and returns `true` when one was handled (the
 * caller must NOT boot the server); it returns `false` only for the bare
 * no-arg invocation, which is the server boot path.
 *
 *   openllmd                      run the daemon (used by the service)
 *   openllmd start                register + start in self-restore mode
 *   openllmd stop                 stop + disable self-restore
 *   openllmd status               show service + run status
 *   openllmd restart              stop then start
 *   openllmd logs [-f] [-n N]     show or follow daemon logs
 *   openllmd auto-update <on|off|status>  opt in/out of self-update (default on)
 *   openllmd anchor < key         accept sk-llm-KEY.ANCHOR (prints the bare key)
 *   openllmd device <disable|status>  device sessions (disable removes the anchor)
 *   openllmd uninstall [--yes] [--keep-logins|--remove-logins]  remove the daemon
 *                                 (--keep-logins preserves ~/.openllm/cli logins)
 *   openllmd completion <shell>   emit / install shell completion
 *   openllmd -h | --help          show help
 *   openllmd -v | --version       show version
 */
import { isAbsolute } from "node:path";
import { autoUpdateEnabled, setAutoUpdate } from "./auto-update-pref";
import { runLinuxPdeathsigWrapper } from "./child-supervisor";
import { COMMANDS, FLAGS, formatHelpRows } from "./commands";
import { runCompletion } from "./completion";
import {
  deviceKeyFingerprint,
  getDeviceAccessPin,
} from "./device-access-verify";
import {
  deviceSessionsReport,
  installDeviceAnchor,
  removeDeviceAnchor,
} from "./device-anchor";
import { loadIdentityKey } from "./keypair";
import { logError } from "./logger";
import { runLogs } from "./logs";
import { runSandboxExec } from "./sandbox/exec";
import {
  serviceRestart,
  serviceStart,
  serviceStatus,
  serviceStop,
} from "./service";
import { runSessionHostProcess } from "./session-host-proc";
import { runUninstall } from "./uninstall";
import { DAEMON_FINGERPRINT, DAEMON_VERSION } from "./version";

const HELP = `openllmd v${DAEMON_VERSION}  —  OpenLLM local daemon

Usage
  openllm daemon [command]      (also: openllmd [command])

Commands
${formatHelpRows([
  {
    left: "(none)",
    right: "Run the daemon in the foreground (used by the service)",
  },
  ...COMMANDS.map((c) => ({
    left: c.args === undefined ? c.name : `${c.name} ${c.args}`,
    right: c.description,
  })),
])}

Flags
${formatHelpRows(FLAGS.map((f) => ({ left: f.name, right: f.description })))}

State lives under ~/.openllm (override with OPENLLM_DAEMON_STATE_DIR).
`;

const DEVICE_USAGE = "usage: openllm daemon device <disable|status>\n";

/**
 * `openllm daemon anchor` — read `sk-llm-<id>.<secret>.<anchor>` from stdin
 * (never argv, so it stays out of `ps`), write `OPENLLM_API_KEY=<bare>` and
 * `OPENLLM_DEVICE_ANCHOR=<anchor>` to the runtime's env file (0600), confirm
 * the derived pin, and print ONLY the bare key on stdout. Exit 2 on a
 * malformed or anchor-less key, 1 when the env-file write did not stick.
 */
const runAnchor = async (args: readonly string[]): Promise<number> => {
  if (args.length > 0) {
    process.stderr.write("usage: openllm daemon anchor < anchored-key\n");
    return 2;
  }
  const input = (await Bun.stdin.text()).trim();
  const result = installDeviceAnchor(input);
  if (!result.ok) {
    process.stderr.write(
      result.reason === "persist_failed"
        ? "could not save the device trust anchor\n"
        : "expected an anchored key (sk-llm-KEY.ANCHOR) on stdin\n",
    );
    return result.reason === "persist_failed" ? 1 : 2;
  }
  process.stderr.write(
    `device-control pinned from the install anchor (${result.controlFingerprint})\n`,
  );
  process.stdout.write(`${result.key}\n`);
  return 0;
};

/** `openllm daemon device <disable|status>`. Disable blanks the anchor. */
const runDevice = (args: readonly string[]): never => {
  const action = args[0];
  if (args.length !== 1 || action === undefined) {
    process.stderr.write(DEVICE_USAGE);
    process.exit(2);
  }
  if (action === "disable") {
    const removed = removeDeviceAnchor();
    if (!removed.ok) {
      process.stderr.write("could not remove the device trust anchor\n");
      process.exit(1);
    }
  } else if (action !== "status") {
    process.stderr.write(DEVICE_USAGE);
    process.exit(2);
  }
  const report = deviceSessionsReport();
  process.stdout.write(
    report.anchored
      ? "device sessions enabled (anchor present)\n"
      : "device sessions disabled (no anchor) — re-run install/update/login with Device sessions on\n",
  );
  process.exit(0);
};

/**
 * Print this daemon's X25519 identity fingerprint and its device-control pin,
 * then exit. Read-only and offline: both come from local state, so a user can
 * compare them with the browser's "Verify device" dialog out of band.
 */
const runIdentity = (args: readonly string[]): never => {
  if (args.length > 0) {
    process.stderr.write("usage: openllm daemon identity\n");
    process.exit(2);
  }
  const identity = loadIdentityKey();
  const pin = getDeviceAccessPin();
  const pinFp = pin === null ? null : deviceKeyFingerprint(pin.pubkey);
  process.stdout.write(
    `identity       ${deviceKeyFingerprint(identity.publicKeyB64) ?? "unknown"}\n` +
      `device-control ${
        pin === null || pinFp === null
          ? "not pinned"
          : `${pinFp} (${pin.kind}${pin.via === null ? "" : `, via ${pin.via}`}${pin.anchored ? ", anchored" : ", not anchored"})`
      }\n`,
  );
  process.exit(0);
};

/**
 * The daemon's user arguments. Bun keeps the entry path at `argv[1]` in BOTH
 * forms — a from-source run (`bun src/main.ts …` → `argv[1]` is the script) and
 * a compiled standalone binary (`argv[1]` is the embedded `/$bunfs/root/…`
 * entry) — so user args always start at index 2.
 */
const userArgs = (): string[] => process.argv.slice(2);

/**
 * Opt in/out of automatic self-updates (or print the current state), then exit.
 * Auto-update is OPT-OUT — a fresh daemon keeps itself current until disabled
 * here or from the dashboard. See `auto-update-pref.ts`.
 */
const runAutoUpdate = (args: readonly string[]): never => {
  const sub = args[0];
  // Each form takes at most one argument — reject trailing junk
  // (`auto-update on typo`) instead of silently ignoring it.
  if (args.length <= 1) {
    if (sub === "on" || sub === "off") {
      setAutoUpdate(sub === "on");
      process.stdout.write(
        `auto-update ${sub === "on" ? "enabled" : "disabled"}\n`,
      );
      process.exit(0);
    }
    if (sub === undefined || sub === "status") {
      process.stdout.write(
        `auto-update is ${autoUpdateEnabled() ? "on" : "off"}\n`,
      );
      process.exit(0);
    }
  }
  process.stderr.write("usage: openllmd auto-update <on|off|status>\n");
  process.exit(2);
};

export const runCli = (args: readonly string[] = userArgs()): boolean => {
  if (args.length === 0) return false; // bare invocation → boot the server

  // The per-child sandbox shim (`sandbox/exec.ts`): apply the working-set
  // sandbox to THIS re-exec'd process, then run the tail argv. Matched BEFORE
  // the `--help`/`--version` scans — the tail may legitimately contain
  // `-h`/`-v`. Nothing heavy loads on this path (no Effect, no env file, no
  // network).
  if (args[0] === "--sandbox-exec") {
    const sep = args.indexOf("--");
    const tail = sep >= 0 ? args.slice(sep + 1) : [];
    if (tail.length === 0) {
      process.stderr.write("--sandbox-exec: missing command\n");
      process.exit(2);
    }
    // `--home <realHome>` (shim flags live BEFORE the `--`): the daemon's real
    // home, used ONLY to build the working set — most call sites spawn the shim
    // with the child's isolated `HOME`. See `sandbox/exec.ts` `HOME_FLAG`.
    const homeFlag = args.indexOf("--home");
    const homeValue =
      homeFlag >= 0 && (sep < 0 || homeFlag < sep)
        ? args[homeFlag + 1]
        : undefined;
    const home =
      homeValue !== undefined && homeValue !== "--" && isAbsolute(homeValue)
        ? homeValue
        : undefined;
    // apply + spawn + mirror exit. `runSandboxExec` never resolves; guard a
    // REJECTION (an unexpected throw before the exit mirror) so it can't
    // become an unhandled rejection / silent success.
    runSandboxExec(tail, home !== undefined ? { home } : undefined).catch(
      (err: unknown) => {
        process.stderr.write(
          `--sandbox-exec: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      },
    );
    return true;
  }

  // Linux-only disposable-child wrapper. Deliberately omitted from
  // COMMANDS/help; its tail may contain `-h` or `-v`, so dispatch before global
  // flag scans. Other platforms never need (or execute) the PDEATHSIG wrapper.
  if (args[0] === "__child-supervisor-pdeathsig") {
    // Never a no-op success: the wrapper is only ever exec'd as argv[0] of a
    // supervised child, so reaching it off-Linux or with a malformed tail is a
    // programming error — fail loudly and deterministically like --sandbox-exec.
    if (process.platform !== "linux") {
      process.stderr.write("__child-supervisor-pdeathsig: Linux-only\n");
      process.exit(2);
    }
    const separator = args.indexOf("--");
    const parentPid = Number.parseInt(args[2] ?? "", 10);
    if (
      args[1] !== "--parent-pid" ||
      separator !== 3 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid <= 0 ||
      args.length <= separator + 1
    ) {
      process.stderr.write(
        "usage: openllmd __child-supervisor-pdeathsig --parent-pid <pid> -- <command> [args...]\n",
      );
      process.exit(2);
    }
    runLinuxPdeathsigWrapper(args.slice(separator + 1), parentPid).catch(
      (err: unknown) => {
        process.stderr.write(
          `__child-supervisor-pdeathsig: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      },
    );
    return true;
  }

  // Internal durable-session host. Deliberately omitted from COMMANDS/help:
  // phase 1c starts it detached, so it must never bootstrap the daemon. This
  // must precede global flag scans because parser values can legitimately be
  // `-h` or `-v` (for example a title or vendor argument).
  if (args[0] === "__session-host") {
    return runSessionHostProcess(args.slice(1));
  }

  if (args[0] === "auth") {
    void import("./auth-cli")
      .then(async ({ runAuthCli }) =>
        process.exit(await runAuthCli(args.slice(1))),
      )
      .catch(() => process.exit(1));
    return true;
  }

  // The updater's daemon-change probe: print this binary's daemon fingerprint.
  // Matched before the flag scans so it never boots or loads config.
  if (args[0] === "--fingerprint") {
    process.stdout.write(`${DAEMON_FINGERPRINT}\n`);
    process.exit(0);
  }

  if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (
    args.includes("--version") ||
    args.includes("-v") ||
    args[0] === "version"
  ) {
    process.stdout.write(`openllmd v${DAEMON_VERSION}\n`);
    process.exit(0);
  }

  const rest = args.slice(1);
  switch (args[0]) {
    case "start":
      process.exit(serviceStart() ? 0 : 1);
      break;
    case "stop":
      serviceStop();
      process.exit(0);
      break;
    case "restart":
      process.exit(serviceRestart() ? 0 : 1);
      break;
    case "status":
      // Async (it probes the running daemon's /status over loopback). Mirror the
      // plugin/setup pattern: the promise process.exit()s when done and
      // returning true prevents the server boot path.
      serviceStatus()
        .then(() => process.exit(0))
        .catch((err) => {
          logError("cli", err);
          process.exit(1);
        });
      return true;
    case "logs":
      runLogs(rest);
      break;
    case "auto-update":
      runAutoUpdate(rest);
      break;
    case "anchor":
      void runAnchor(rest).then((code) => process.exit(code));
      return true;
    case "device":
      runDevice(rest);
      break;
    case "identity":
      runIdentity(rest);
      break;
    case "uninstall":
      runUninstall(rest);
      break;
    case "completion":
      runCompletion(rest);
      break;
    default:
      process.stderr.write(`unknown command: ${args[0]}\n\n${HELP}`);
      process.exit(2);
  }
  return true;
};
