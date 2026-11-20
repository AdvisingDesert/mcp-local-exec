---
trigger: always_on
description: Delegate terminal commands to a local Ollama model via MCP to save context tokens.
---

## Terminal Delegation (local-exec)

- For verbose or exploratory terminal operations (`git status`/`diff`, file search, `grep`, log inspection, quick checks), do NOT run shell commands directly: delegate the full objective to the `local_exec` MCP tool.
- Delegate complete goals to `local_exec`, not single atomic commands.
- Only fall back to running terminal commands directly if `local_exec` fails after its 2 automatic retries.
- Never run project builds through `local_exec`.
