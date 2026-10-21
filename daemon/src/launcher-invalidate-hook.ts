/**
 * Leaf hook that breaks the init cycle:
 * launcher-resolution → manager-resolution → spawn → launcher-exec-invalidate
 * → (previously) launcher-resolution.
 *
 * The production resolver registers its invalidator here at module init;
 * spawn-side ENOENT/EACCES handling looks it up without importing the
 * resolver module.
 */

export type TLauncherResolutionInvalidator = (candidate: string) => void;

let registered: TLauncherResolutionInvalidator | undefined;

export const registerLauncherResolutionInvalidator = (
  invalidate: TLauncherResolutionInvalidator,
): void => {
  registered = invalidate;
};

export const registeredLauncherResolutionInvalidator = ():
  | TLauncherResolutionInvalidator
  | undefined => registered;
