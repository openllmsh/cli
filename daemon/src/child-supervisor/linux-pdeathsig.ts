/**
 * Linux-only parent-death-signal wrapper entry. The daemon CLI dispatcher must
 * route a hidden `__child-supervisor-pdeathsig --parent-pid <pid> -- <argv…>`
 * command here before callers can use it as `superviseSpawn`'s argv[0] wrapper.
 * Keep that dispatch in the compiled binary: it is what makes this module
 * available in the source-free distribution.
 */
/**
 * Wrap an argv so it runs under the Linux PDEATHSIG helper: the daemon re-execs
 * itself into `__child-supervisor-pdeathsig --parent-pid <pid> -- <argv…>`, which
 * sets `PR_SET_PDEATHSIG` before exec'ing the real command. The `--parent-pid`
 * guard closes the fork/exec race (the wrapper exits if the daemon already died).
 * The layout matches the CLI dispatcher's parse (`separator === 3`).
 */
export const linuxPdeathsigArgv = (
  argv: ReadonlyArray<string>,
  selfInvocation: ReadonlyArray<string>,
  parentPid: number,
): readonly string[] => [
  ...selfInvocation,
  "__child-supervisor-pdeathsig",
  "--parent-pid",
  String(parentPid),
  "--",
  ...argv,
];

const cString = (value: string): Uint8Array => {
  const encoded = new TextEncoder().encode(value);
  const out = new Uint8Array(encoded.length + 1);
  out.set(encoded);
  return out;
};

/**
 * Set Linux PDEATHSIG, re-check the parent to close the setup race, then exec
 * the requested command in-place. It only returns by throwing when setup or
 * exec fails; a successful exec retains the configured death signal.
 */
export const runLinuxPdeathsigWrapper = async (
  argv: ReadonlyArray<string>,
  expectedParentPid: number,
): Promise<never> => {
  if (process.platform !== "linux") throw new Error("PDEATHSIG is Linux-only");
  if (argv.length === 0 || argv[0] === undefined)
    throw new Error("PDEATHSIG wrapper requires a command");
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const libcSymbols = {
    prctl: {
      args: [FFIType.i32, FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i64],
      returns: FFIType.i32,
    },
    getppid: { args: [], returns: FFIType.i32 },
    execvp: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  } as const;
  // glibc ships `libc.so.6`; musl (Alpine, and the linux-*-baseline targets can
  // land there) ships `libc.musl-<arch>.so.1` and has no `libc.so.6`. Try the
  // common sonames in turn so the wrapper works on both libc flavors.
  const muslArch =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x86_64"
        : null;
  const libcCandidates = [
    "libc.so.6",
    ...(muslArch === null ? [] : [`libc.musl-${muslArch}.so.1`]),
    "libc.so",
  ];
  let symbols: ReturnType<typeof dlopen>["symbols"] | null = null;
  for (const soname of libcCandidates) {
    try {
      symbols = dlopen(soname, libcSymbols).symbols;
      break;
    } catch {
      // Try the next libc soname.
    }
  }
  if (symbols === null) throw new Error("PDEATHSIG: no loadable libc found");
  const prctl = symbols.prctl as unknown as (
    option: number,
    argument2: number,
    argument3: bigint,
    argument4: bigint,
    argument5: bigint,
  ) => number;
  const getppid = symbols.getppid as unknown as () => number;
  const execvp = symbols.execvp as unknown as (
    file: number,
    argv: number,
  ) => number;
  const PR_SET_PDEATHSIG = 1;
  const SIGTERM = 15;
  if (prctl(PR_SET_PDEATHSIG, SIGTERM, 0n, 0n, 0n) !== 0)
    throw new Error("prctl(PR_SET_PDEATHSIG) failed");
  if (getppid() !== expectedParentPid) process.exit(1);
  const encoded = argv.map(cString);
  const pointers = new Uint8Array((encoded.length + 1) * 8);
  const pointerView = new DataView(pointers.buffer);
  for (const [index, value] of encoded.entries())
    pointerView.setBigUint64(index * 8, BigInt(ptr(value)), true);
  // Keep both backing buffers alive across the native call.
  void encoded;
  void pointers;
  execvp(ptr(encoded[0] as Uint8Array), ptr(pointers));
  throw new Error("execvp failed");
};
