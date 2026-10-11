/**
 * API-key media hops must rewrite the inbound body to the CURRENT hop's
 * model. Pinning `x-openllm-pin-model` is not enough — the cloud media
 * handlers honor the JSON/multipart `model` field, so a leftover first-hop
 * id would re-request the subscription (or the previous API hop).
 */

import { forwardToCloud } from "./forward";
import { materializeSelectedModel } from "./media-default-handoff";
import type { TParsedMultipart } from "./multipart";
import { parseMultipartBytes } from "./multipart";
import type { TWalkArgs } from "./walker";

export const forwardMediaHopToCloud = async (
  args: TWalkArgs,
  hopModelId: string,
  multipart: TParsedMultipart | null = null,
): Promise<Response> => {
  const requestContentType = args.req.headers.get("content-type") ?? "";
  let parsed = multipart;
  if (parsed === null && requestContentType.includes("multipart/form-data")) {
    parsed = await parseMultipartBytes(
      new Uint8Array(args.rawBytes),
      requestContentType,
    );
  }
  const materialized = await materializeSelectedModel({
    model: hopModelId,
    rawBody: args.rawBody,
    rawBytes: args.rawBytes,
    multipart: parsed,
    requestContentType,
  });
  const headers = new Headers(args.req.headers);
  if (materialized.contentType !== null) {
    headers.set("content-type", materialized.contentType);
    headers.delete("content-length");
  }
  const inbound = new Request(args.req.url, {
    method: args.req.method,
    headers,
    signal: args.req.signal,
  });
  return forwardToCloud(
    inbound,
    materialized.rawBytes,
    hopModelId,
    args.originParam,
  );
};
