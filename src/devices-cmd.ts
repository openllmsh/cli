/**
 * `openllm devices [--json]` — the account's devices as the cloud sees them:
 * which are online and which subscription / local providers each serves.
 *
 * Read-only and cloud-only: it never touches a local daemon, starts a login
 * or changes anything. It exists so an agent in a sandbox can answer "do
 * this user's own computers already serve Claude Code?" in one command
 * before it considers signing anything in on the sandbox (it shouldn't —
 * `openllm <client>` reaches those devices through the cloud).
 */
import { cliConfig } from "./env";

export const DEVICES_USAGE = `usage: openllm devices [--json]

List this account's devices: online or not, and the subscription and local
providers each one serves. Read-only; needs a key (openllm login).
Requests from \`openllm <client>\` reach these devices through the cloud, so a
sandbox never needs its own provider login when a device here is online.
`;

type TDevice = {
  readonly name: string;
  readonly online: boolean;
  readonly last_seen: string | null;
  readonly providers: ReadonlyArray<string>;
  readonly local_models: ReadonlyArray<string>;
  readonly this_key: boolean;
};

type TDevicesBody = {
  readonly devices: ReadonlyArray<TDevice>;
  readonly any_online: boolean;
};

const isDevicesBody = (value: unknown): value is TDevicesBody =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { devices?: unknown }).devices) &&
  typeof (value as { any_online?: unknown }).any_online === "boolean";

/** Human lines for a devices response. Pure, for tests. */
export const renderDevices = (body: TDevicesBody): string => {
  if (body.devices.length === 0)
    return "No devices yet. Connect a computer from the dashboard (Connections → Add a computer).\n";
  const lines = body.devices.map((d) => {
    const state = d.online ? "online " : "offline";
    const serves =
      d.providers.length > 0 ? d.providers.join(", ") : "no providers";
    const self = d.this_key ? " (this key)" : "";
    return `${state}  ${d.name}${self} — ${serves}`;
  });
  const hint = body.any_online
    ? "\nOnline devices serve their providers to `openllm <client>` here; no local login needed.\n"
    : "\nNo device is online and serving. Subscription and local models need the user to start OpenLLM on their own computer; included and API-key models still work through the cloud.\n";
  return `${lines.join("\n")}\n${hint}`;
};

export const runDevicesCommand = async (
  args: ReadonlyArray<string>,
): Promise<number> => {
  const json = args.includes("--json");
  if (args.some((a) => a !== "--json")) {
    process.stderr.write(DEVICES_USAGE);
    return 2;
  }
  const { gatewayUrl, apiKey } = cliConfig();
  if (apiKey === "") {
    process.stderr.write(
      "No OpenLLM key on this machine. Run `openllm login --non-interactive` first.\n",
    );
    return 1;
  }
  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}/api/devices`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    process.stderr.write(
      `Couldn't reach ${gatewayUrl}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isDevicesBody(body)) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    process.stderr.write(`Couldn't list devices: ${message}\n`);
    return 1;
  }
  process.stdout.write(
    json ? `${JSON.stringify(body, null, 2)}\n` : renderDevices(body),
  );
  return 0;
};
