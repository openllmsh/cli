/** The MCP tool-result envelope every group's handlers return. */
export type TToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};
