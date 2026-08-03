--------------------------------MAIN POLICY--------------------------------
Use `ultra` for authoritative tasks (framing, decisions, synthesis)
Use `plus` for execution tasks that require some intelligence
Use `lite` for repetitive tasks that require no intelligence
if ultra, plus, lite models are not available, call v1/models to get equivalent tiers
openllm model format is <provider>/<model_name> - it has fuzzy resolution support if not specified
NEVER spawn sub-agents without specifying a the model
NEVER spawn sub-agents in an isolated worktrees
ALWAYS spawn sub-agents in the same worktree
ALWAYS prefer delegating work to sub-agents
ONLY use the main session for orchestration of sub-agents
--------------------------------END OF POLICY--------------------------------
