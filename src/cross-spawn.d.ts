declare module "cross-spawn" {
  import type { ChildProcess, SpawnOptions } from "node:child_process";

  const crossSpawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;

  export default crossSpawn;
}

declare module "cross-spawn/lib/util/escape.js" {
  const commandEscaper: {
    readonly command: (command: string) => string;
    readonly argument: (
      argument: string,
      doubleEscapeMetaChars: boolean,
    ) => string;
  };

  export default commandEscaper;
}
