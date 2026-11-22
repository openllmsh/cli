/**
 * Whether a gateway origin may carry a key or a binary: https, or http to the
 * local loopback. Its own module (no imports) so the daemon half can use it
 * without reaching `self-update.ts`, which imports the release manifest.
 */
export const isSecureOrigin = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
};
