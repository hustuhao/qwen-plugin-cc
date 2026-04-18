---
description: Cancel an active background Qwen job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" cancel "$ARGUMENTS"`
