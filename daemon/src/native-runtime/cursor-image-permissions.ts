/**
 * Image-mode ACP server-request handler. Chat {@link handleCursorServerRequest}
 * auto-approves every native tool; image generation must NOT. Only the native
 * Generate Image tool is allowed. Unidentifiable permission asks are rejected
 * (fail closed). `cursor/generate_image` is never treated as a client RPC we
 * implement — if the agent sends it as a server request we refuse it; native
 * generation is the agent's own Generate Image tool_call.
 */

const REJECT_ONCE = "reject-once";

type TPermissionOption = {
  readonly optionId?: unknown;
  readonly kind?: unknown;
};

const rejectOutcome = (
  options: ReadonlyArray<TPermissionOption> | undefined,
): {
  readonly outcome: { readonly outcome: "selected"; readonly optionId: string };
} => {
  const pick = Array.isArray(options)
    ? (options.find((o) => o.kind === "reject_once") ??
      options.find((o) => o.kind === "reject_always"))
    : undefined;
  const optionId =
    typeof pick?.optionId === "string" ? pick.optionId : REJECT_ONCE;
  return { outcome: { outcome: "selected", optionId } };
};

const allowOutcome = (
  options: ReadonlyArray<TPermissionOption> | undefined,
): {
  readonly outcome: { readonly outcome: "selected"; readonly optionId: string };
} => {
  const pick = Array.isArray(options)
    ? (options.find((o) => o.kind === "allow_once") ??
      options.find((o) => o.kind === "allow_always"))
    : undefined;
  const optionId =
    typeof pick?.optionId === "string" ? pick.optionId : "allow-once";
  return { outcome: { outcome: "selected", optionId } };
};

const GENERATE_IMAGE_RE = /generate[\s_-]*image/i;

/** True when an ACP permission / tool payload names the Generate Image tool. */
export const isCursorGenerateImageTool = (value: unknown): boolean => {
  if (typeof value === "string") return GENERATE_IMAGE_RE.test(value);
  if (typeof value !== "object" || value === null) return false;
  const o = value as {
    readonly title?: unknown;
    readonly kind?: unknown;
    readonly toolName?: unknown;
    readonly name?: unknown;
    readonly toolCall?: unknown;
  };
  const fields = [o.title, o.kind, o.toolName, o.name];
  if (fields.some((f) => typeof f === "string" && GENERATE_IMAGE_RE.test(f))) {
    return true;
  }
  if (o.toolCall !== undefined) return isCursorGenerateImageTool(o.toolCall);
  return false;
};

/**
 * SECURITY (concrete, evidenced — now LIVE-verified): native tool-call
 * auto-run posture for Cursor ACP image mode.
 *
 * Evidence — installed `cursor-agent` 2026.07.23-e383d2b:
 *   `cursor-agent acp --help` lists ONLY `-h, --help`. The ACP subcommand
 *   exposes no permission/sandbox/allowed-tools flag of its own. The
 *   top-level `agent` command's `--sandbox <enabled|disabled>`,
 *   `--mode <plan|ask>` and `-f/--force` are documented only for the
 *   interactive/print command, and the binary does not reject them when
 *   placed before `acp`.
 *
 *   LIVE RUN (2026-09-17, authenticated real account, real ACP session, see
 *   `tests/transport/cursor-native-sandbox-flags-live.e2e.test.ts`):
 *   prepending `--sandbox enabled` before `acp` changes NOTHING observable.
 *   Both the flag-less baseline and the `--sandbox enabled` session:
 *     (a) DID send `session/request_permission` for the native Edit/Shell
 *         tools (so the earlier "frequently does not ask" caveat undersold
 *         it — it CAN ask for these two);
 *     (b) when every such ask was REJECTED (`reject-once`, the same fixture
 *         handler `handleCursorImageServerRequest` uses), the agent simply
 *         RETRIED the identical tool_call a second time with no further ask
 *         and it SUCCEEDED — both a file-write and a shell-redirect marker
 *         landed on disk with the correct content despite every permission
 *         ask on that turn being denied. Denial is not just occasionally
 *         skipped; it is actively bypassable by the agent's own retry;
 *     (c) a native Read tool_call fetched a decoy file OUTSIDE the session
 *         `cwd` (a sibling scratch directory) and the exact secret content
 *         came back in the model's reply — despite `clientCapabilities.fs`
 *         being advertised OFF. Cursor's native fs/shell tools run through
 *         the vendor's own local execution engine directly against the host
 *         filesystem; they are not mediated by the ACP client-capability
 *         negotiation at all, flag or no flag.
 *   `--sandbox enabled` was also confirmed COMPATIBLE with Generate Image
 *   (the tool_call still fires, the turn still completes) — but since the
 *   flag adds no verified protection, there is no benefit to threading it
 *   through `runCursorNativeImage`'s spawn args, and it is NOT added.
 *
 * Conclusion (UPGRADED from inference to live proof): no verified
 * before-the-fact mechanism exists — with or without `--sandbox enabled` —
 * to stop the agent auto-running or retrying-past-a-denial a non-image
 * native tool (Shell, Write, Read, Edit, …) inside an ACP session at this
 * CLI version. `session/request_permission` denial (`rejectOutcome` above)
 * is, at best, a speed bump the agent can and does route around by
 * retrying; it is not a gate. Cancelling the session when a foreign
 * `tool_call` is observed (`runCursorNativeImage` in `cursor-acp.ts`) is
 * cleanup AFTER an already-started (and possibly already-succeeded) action,
 * not prevention, and MUST NOT be reported or relied on as a sandbox
 * guarantee. `enforced: false` here is the signal a future
 * capability-negotiation layer should gate the image-generation entry point
 * on; this module does not itself decide whether to expose that entry
 * point. Do not flip `enforced` to `true` without a NEW verified mechanism —
 * this live run closes the `--sandbox` avenue, it does not open one.
 */
export const cursorImageToolEnforcement = {
  enforced: false,
  mechanism: "none-verified",
  reason:
    "cursor-agent acp exposes no permission/sandbox flags of its own, and a live run confirms --sandbox enabled (placed before acp) changes nothing: session/request_permission denial is bypassed by the agent simply retrying the same tool_call, and native Shell/Read/Write/Edit run through cursor's own local execution engine, unmediated by our declared ACP client capabilities; session/cancel on a foreign tool_call is cleanup, not prevention",
} as const;

export type TCursorImageToolEnforcement = typeof cursorImageToolEnforcement;

export const handleCursorImageServerRequest = (
  method: string,
  params: unknown,
): unknown => {
  if (method === "cursor/generate_image") {
    // Agent-to-client generate request — we do not implement client-side
    // generation and never invoke this as a client RPC.
    return null;
  }
  if (method === "session/request_permission") {
    const p = params as {
      readonly options?: ReadonlyArray<TPermissionOption>;
      readonly toolCall?: unknown;
      readonly title?: unknown;
    };
    if (isCursorGenerateImageTool(p) || isCursorGenerateImageTool(p.toolCall)) {
      return allowOutcome(p.options);
    }
    return rejectOutcome(p.options);
  }
  if (method === "cursor/ask_question") {
    return {
      answers: [],
    };
  }
  return null;
};
