/**
 * Re-export protocol local-server presets for the daemon discovery loop.
 * One shared catalog with the UI / cloud — never fork the port table here.
 */
export {
  LOCAL_SERVER_PRESETS,
  isLocalServerPresetSlug,
  isLocalServerSlug,
  localPortSlug,
  localProviderVariant,
  localServerPresetByPort,
  localServerPresetBySlug,
  parseLocalPortSlug,
} from "@openllmsh/protocol";
export type {
  TLocalServerPreset,
  TLocalServerPresetSlug,
} from "@openllmsh/protocol";
