/**
 * Bidirectional guard for two-process pipelines (`curl | bash`, etc.).
 *
 * A failure in either child must kill the peer so a broken pipe cannot hang
 * waiting for the other half, and a download failure cannot be masked by the
 * consumer exiting 0 on empty input.
 */

export type TPipePeer = {
  readonly exited: Promise<number>;
  readonly kill: () => void;
};

/** Kill the peer process if THIS one exits nonzero, then yield its code. */
export const guardPeerExit = (
  proc: TPipePeer,
  peer: TPipePeer,
  killed: { done: boolean },
): Promise<number> =>
  proc.exited.then((code) => {
    if (code !== 0 && !killed.done) {
      killed.done = true;
      try {
        peer.kill();
      } catch {
        // already exited — nothing to signal
      }
    }
    return code;
  });

/** Wait for both peers; either nonzero exit kills the other. */
export const awaitPipeCodes = async (
  left: TPipePeer,
  right: TPipePeer,
): Promise<readonly [number, number]> => {
  const killed = { done: false };
  return Promise.all([
    guardPeerExit(left, right, killed),
    guardPeerExit(right, left, killed),
  ]);
};

/** Adapt a `Bun.Subprocess` to the pipe-peer contract. */
export const bunSubprocessPeer = (proc: Bun.Subprocess): TPipePeer => ({
  exited: proc.exited.then((code) => code),
  kill: (): void => {
    proc.kill();
  },
});
