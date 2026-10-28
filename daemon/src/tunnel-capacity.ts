const DEFAULT_SERVED_TUNNEL_CAPACITY = 16;
const MIN_SERVED_TUNNEL_CAPACITY = 1;
const MAX_SERVED_TUNNEL_CAPACITY = 256;

const configuredCapacity = (): number => {
  const raw = process.env.OPENLLM_DAEMON_MAX_SERVED_TUNNELS;
  if (raw === undefined) return DEFAULT_SERVED_TUNNEL_CAPACITY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_SERVED_TUNNEL_CAPACITY;
  return Math.min(
    MAX_SERVED_TUNNEL_CAPACITY,
    Math.max(MIN_SERVED_TUNNEL_CAPACITY, parsed),
  );
};

export const servedTunnelCapacity = (): number => configuredCapacity();

let servedTunnelCount = 0;

export const servedTunnelLoad = (): number => servedTunnelCount;

export const canServeTunnel = (): boolean =>
  servedTunnelCount < servedTunnelCapacity();

export const beginServedTunnel = (): number => {
  servedTunnelCount += 1;
  return servedTunnelCount;
};

export const endServedTunnel = (): void => {
  servedTunnelCount = Math.max(0, servedTunnelCount - 1);
};
