/** Build a Bun.spawn command, accounting for Windows command-script shims. */
export const spawnCommand = (
  platform: NodeJS.Platform,
  target: string,
  args: readonly string[],
): string[] =>
  platform === "win32" && target.toLowerCase().endsWith(".cmd")
    ? ["cmd.exe", "/c", target, ...args]
    : [target, ...args];
