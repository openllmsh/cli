/**
 * Download a release binary with a STALL timeout, not a total deadline: the
 * binary is ~120 MB, and a fixed deadline cut off every connection slower than
 * size/deadline, forever. Give up only when bytes stop arriving. Shared by the
 * CLI's `openllm self-update` and the daemon updater; dependency-free.
 */
export const BINARY_STALL_TIMEOUT_MS = 30_000;

export const downloadWithStallTimeout = async (
  url: string,
  onProgress?: (received: number, total: number | null) => void,
  stallMs: number = BINARY_STALL_TIMEOUT_MS,
): Promise<Buffer> => {
  const abort = new AbortController();
  let stall = setTimeout(() => abort.abort(), stallMs);
  const bump = (): void => {
    clearTimeout(stall);
    stall = setTimeout(() => abort.abort(), stallMs);
  };
  const chunks: Uint8Array[] = [];
  try {
    const res = await fetch(url, { redirect: "follow", signal: abort.signal });
    if (!res.ok) throw new Error(`binary download failed: ${res.status}`);
    if (res.body === null) throw new Error("binary download had no body");
    const length = Number(res.headers.get("content-length"));
    const total = Number.isFinite(length) && length > 0 ? length : null;
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(received, total);
      bump();
    }
  } catch (err) {
    if (abort.signal.aborted) throw new Error("binary download stalled");
    throw err;
  } finally {
    clearTimeout(stall);
  }
  return Buffer.concat(chunks);
};
