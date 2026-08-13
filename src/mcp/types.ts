/** The MCP tool-result envelope every group's handlers return. */
export type TToolResultContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | {
      readonly type: "audio";
      readonly data: string;
      readonly mimeType: string;
    };

export type TToolResult = {
  content: Array<TToolResultContent>;
  isError?: boolean;
};
