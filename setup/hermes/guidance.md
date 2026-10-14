## OpenLLM tools

### Cross-session memory
- `mcp__openllm__memory` (action: "save" | "forget") and `mcp__openllm__recall`
  are the SINGLE source of truth for remembering things across conversations.
  Do NOT use file-based auto-memory paths — that backend is superseded by these
  tools.
- Projects are auto-scoped from the working directory; pass an explicit
  `project` only when discussing a different repo than the cwd.
- PROACTIVELY save when the user has CONCLUDED something: a stated preference or
  working-style rule, a fact about themselves/team/stack, explicit assent to a
  non-obvious proposal, corrective feedback, an external resource (ticket,
  channel, dashboard), or a goal/deadline/constraint not derivable from code.
  Do NOT save speculation, rejected proposals, ephemeral task state, or anything
  already in the repo. Use "forget" (often paired with a save) when the user
  contradicts or supersedes a prior memory.
- Recall when the user references past work ("like we did before"), asks
  something that depends on prior context, or at the start of a non-trivial
  task — query once up front.
