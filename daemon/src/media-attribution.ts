/**
 * Final-hop attribution for daemon media responses.
 */

import {
  OPENLLM_CHAIN_HEADER,
  OPENLLM_RESOLVED_MODEL_HEADER,
} from "@openllmsh/protocol";

export { OPENLLM_CHAIN_HEADER, OPENLLM_RESOLVED_MODEL_HEADER };

export const withMediaAttribution = (
  resp: Response,
  args: {
    readonly resolvedModel?: string;
    readonly attempted: ReadonlyArray<string>;
  },
): Response => {
  if (args.attempted.length === 0 && args.resolvedModel === undefined) {
    return resp;
  }
  const headers = new Headers(resp.headers);
  if (args.attempted.length > 0 && !headers.has(OPENLLM_CHAIN_HEADER)) {
    headers.set(OPENLLM_CHAIN_HEADER, args.attempted.join(","));
  }
  if (
    args.resolvedModel !== undefined &&
    args.resolvedModel.length > 0 &&
    !headers.has(OPENLLM_RESOLVED_MODEL_HEADER)
  ) {
    headers.set(OPENLLM_RESOLVED_MODEL_HEADER, args.resolvedModel);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
};
