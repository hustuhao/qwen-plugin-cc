---
description: Check whether the local Qwen CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" setup --json $ARGUMENTS
```

If the result says Qwen Code is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Qwen Code now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Qwen Code (Recommended)`
  - `Skip for now`
- If the user chooses install, guide them to run the official installer:
  - macOS/Linux: `bash -c "$(curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh)"`
  - Windows: follow instructions at https://help.aliyun.com/zh/model-studio/qwen-code
- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" setup --json $ARGUMENTS
```

If Qwen is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Qwen is installed but not authenticated, preserve the guidance to run `!qwen login`.
