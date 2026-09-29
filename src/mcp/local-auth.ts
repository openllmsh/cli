/** LOCAL stdio registration only. Never import this from cloud/browser tool lists. */
import { runAuthCommand } from "../auth-command";
import { AUTH_CODE_MAX_BYTES, AUTH_COMMANDS } from "../generated/local-auth";
import type { TToolResult } from "./types";

export const localAuthToolDefs = AUTH_COMMANDS.map((descriptor) => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (descriptor.provider !== "none")
    properties.provider = {
      type: "string",
      description: "Exact provider from local_auth_providers on this machine",
    };
  if (descriptor.provider === "required") required.push("provider");
  for (const field of descriptor.fields) {
    properties[field] =
      field === "method"
        ? {
            type: "string",
            enum: ["browser", "device"],
            description:
              "Must be advertised by local_auth_providers; omit for native primary method",
          }
        : field === "code"
          ? {
              type: "string",
              minLength: 1,
              maxLength: AUTH_CODE_MAX_BYTES,
              description:
                "User-supplied paste-back code, forwarded over stdin only; never log or echo it",
            }
          : {
              type: "string",
              description:
                "Originating login flow_id returned by local_auth_login",
            };
  }
  if (descriptor.name === "submit-code") required.push("flow_id", "code");
  return {
    name: `local_auth_${descriptor.name.replaceAll("-", "_")}`,
    description: `${descriptor.description}. This machine only; never controls another device or falls back to cloud. ${descriptor.mutating ? "MUTATING — call only when the user explicitly requested this action. Vendor consent may still require the user. Command acceptance is not authenticated success; explicitly check status with the returned flow_id. No autonomous polling or login." : "Read-only; does not start authentication or refresh usage. Status returns a login prompt only for a matching locally initiated flow_id; recheck explicitly and boundedly."}`,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: !descriptor.mutating,
      destructiveHint: descriptor.name === "logout",
      openWorldHint: descriptor.mutating,
    },
    operation: descriptor.name,
  };
});
export const isLocalAuthTool = (name: string): boolean =>
  localAuthToolDefs.some((tool) => tool.name === name);
export const handleLocalAuthTool = async (
  name: string,
  args: Record<string, unknown>,
): Promise<TToolResult> => {
  const descriptor = localAuthToolDefs.find((tool) => tool.name === name);
  if (descriptor === undefined || Object.hasOwn(args, "operation"))
    return {
      isError: true,
      content: [{ type: "text", text: "Invalid local auth tool" }],
    };
  const result = await runAuthCommand({
    ...args,
    operation: descriptor.operation,
  });
  return {
    ...(result.ok ? {} : { isError: true }),
    content: [{ type: "text", text: JSON.stringify(result.body) }],
  };
};
