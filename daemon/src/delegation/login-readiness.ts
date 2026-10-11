import type { TStoreRead } from "./util";

export const KEYCHAIN_NOT_READY_DETAIL =
  "could not prepare the credential store for sign-in";

export const loginReady = (ready: TStoreRead<void> | void): boolean =>
  ready === undefined || ready.kind === "present";
