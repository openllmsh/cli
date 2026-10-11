/**
 * Pure classification of the `/v1/videos` surface — kept dependency-free so the
 * listener's routing decision is unit-testable without pulling in the (cyclic)
 * listener/tunnel-server module graph.
 *
 * The four operations follow the OpenAI Videos convention: POST /v1/videos
 * creates a job; GET /v1/videos/{id} polls it; GET /v1/videos/{id}/content
 * downloads the finished MP4; DELETE /v1/videos/{id} cancels it. Only `create`
 * carries a request body — the id-addressed ops MUST skip surface-body
 * validation (their signed plan rides the query string).
 */
export type TVideoOperation = "create" | "poll" | "content" | "cancel";

export type TVideoRoute = {
  readonly operation: TVideoOperation | null;
  readonly videoId: string | undefined;
};

/** Classify a request's method + `/api`-normalized pathname into a video op. */
export const videoOperationFor = (
  method: string,
  normalizedPath: string,
): TVideoRoute => {
  const match = normalizedPath.match(/^\/v1\/videos\/([^/]+)(?:\/(content))?$/);
  const videoId = match?.[1];
  const operation: TVideoOperation | null =
    method === "POST" && normalizedPath === "/v1/videos"
      ? "create"
      : method === "GET" && videoId !== undefined && match?.[2] === "content"
        ? "content"
        : method === "GET" && videoId !== undefined
          ? "poll"
          : method === "DELETE" && videoId !== undefined
            ? "cancel"
            : null;
  return { operation, videoId };
};

/**
 * The id-addressed video ops (poll/content/cancel) carry no request body, so
 * the listener must set `rawBody = null` AND skip surface-body validation for
 * them — validating a null body against the chat-completion schema 400s.
 */
export const isBodylessVideoOp = (op: TVideoOperation | null): boolean =>
  op === "poll" || op === "content" || op === "cancel";
