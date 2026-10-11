/**
 * Where a user's `mise` keeps its GLOBAL roots — config, data (installs +
 * shims + its own launcher), state and cache. One derivation shared by the
 * manager-resolution adapter (which reads the global config file) and the
 * sandbox working set (which must grant these so `mise which` and mise shims
 * can run under Landlock/Seatbelt — without them every mise-managed vendor CLI
 * fails with `failed read_to_string … config.toml: Permission denied`).
 *
 * Follows https://mise.jdx.dev/directories.html: an explicit `MISE_*_DIR`
 * wins, then the XDG base dir, then the XDG default under `home`.
 */
import { join } from "node:path";

export type TMisePaths = {
  /** `$MISE_CONFIG_DIR` or `$XDG_CONFIG_HOME/mise` (`~/.config/mise`). */
  readonly configDir: string;
  /** `$MISE_GLOBAL_CONFIG_FILE` or `<configDir>/config.toml`. */
  readonly globalConfigFile: string;
  /** `$MISE_DATA_DIR` or `$XDG_DATA_HOME/mise` (`~/.local/share/mise`). */
  readonly dataDir: string;
  /** `$MISE_STATE_DIR` or `$XDG_STATE_HOME/mise` (`~/.local/state/mise`). */
  readonly stateDir: string;
  /** `$MISE_CACHE_DIR` or `$XDG_CACHE_HOME/mise` (`~/.cache/mise`). */
  readonly cacheDir: string;
};

const nonEmpty = (v: string | undefined): string | undefined =>
  v !== undefined && v.length > 0 ? v : undefined;

export const misePaths = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): TMisePaths => {
  const xdg = (key: string, ...fallback: string[]): string =>
    join(nonEmpty(env[key]) ?? join(home, ...fallback), "mise");
  const configDir =
    nonEmpty(env.MISE_CONFIG_DIR) ?? xdg("XDG_CONFIG_HOME", ".config");
  return {
    configDir,
    globalConfigFile:
      nonEmpty(env.MISE_GLOBAL_CONFIG_FILE) ?? join(configDir, "config.toml"),
    dataDir:
      nonEmpty(env.MISE_DATA_DIR) ?? xdg("XDG_DATA_HOME", ".local", "share"),
    stateDir:
      nonEmpty(env.MISE_STATE_DIR) ?? xdg("XDG_STATE_HOME", ".local", "state"),
    cacheDir: nonEmpty(env.MISE_CACHE_DIR) ?? xdg("XDG_CACHE_HOME", ".cache"),
  };
};
