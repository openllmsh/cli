## OpenLLM tools

### Cross-session memory
- `mcp__openllm__memory` (action: "save" | "forget") and `mcp__openllm__recall`
  are for remembering things across conversations. If the user asks to bring
  existing memory files into OpenLLM, run `openllm exec memory import [path]`
  (reads only; `--dry-run` previews).
- Projects are auto-scoped from the working directory; pass an explicit
  `project` only when discussing a different repo than the cwd.
- PROACTIVELY save when the user has CONCLUDED something: a stated preference or
  working-style rule, a fact about themselves/team/stack, explicit assent to a
  non-obvious proposal, corrective feedback, an external resource (ticket,
  channel, dashboard), or a goal/deadline/constraint not derivable from code.
  Do NOT save speculation, rejected proposals, ephemeral task state, or anything
  already in the repo/CLAUDE.md. Use "forget" (often paired with a save) when
  the user contradicts or supersedes a prior memory.
- Recall when the user references past work ("like we did before"), asks
  something that depends on prior context, or at the start of a non-trivial
  task — query once up front. A UserPromptSubmit hook auto-injects relevant
  memories on every prompt (a "[memory] Relevant saved memories" block)
  — when one is present, only re-query with a different angle.
- A background Stop hook also extracts confirmed conclusions after each
  exchange; explicit MCP saves always win over it.
