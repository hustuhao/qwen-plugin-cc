# Qwen plugin for Claude Code

> [!NOTE]
> This plugin is developed based on codex-plugin-cc v1.0.3.
 
[English](./README.md) | [中文](./README_zh.md)

Use Qwen from inside Claude Code for code reviews or to delegate tasks to Qwen.

This plugin is for Claude Code users who want an easy way to start using Qwen from the workflow
they already have.

## What You Get

- `/qwen:review` for a normal read-only Qwen review
- `/qwen:adversarial-review` for a steerable challenge review
- `/qwen:rescue`, `/qwen:status`, `/qwen:result`, and `/qwen:cancel` to delegate work and manage background jobs

## Requirements

- Alibaba Cloud Bailian API Key or Qwen Code account.
- An API Key configuration is required to use this plugin. [View the configuration documentation](https://help.aliyun.com/zh/model-studio/qwen-code).
- Node.js 20 or later.


## Install

Please visit the official website for installation instructions:

[https://qwen.ai/qwencode](https://qwen.ai/qwencode)

Then run:

```bash
/qwen:setup
```

`/qwen:setup` will tell you whether Qwen Code is ready. If Qwen Code is missing, it can offer to install it for you.

If you prefer to install Qwen Code yourself, use:

```bash
bash -c "$(curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh)"
```

If Qwen Code is installed but not configured yet, run:

```bash
!qwen login
```

After install, you should see:

- the slash commands listed below
- the `qwen:qwen-rescue` subagent in `/agents`

One simple first run is:

```bash
/qwen:review --background
/qwen:status
/qwen:result
```

## Usage

### `/qwen:review`

Runs a normal Qwen review on your current work. It gives you the same quality of code review as running `/review` inside Qwen directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/qwen:adversarial-review`](#qwenadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/qwen:review
/qwen:review --base main
/qwen:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/qwen:status`](#qwenstatus) to check on the progress and [`/qwen:cancel`](#qwencancel) to cancel the ongoing task.

### `/qwen:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/qwen:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/qwen:review`, it can take extra focus text after the flags.
Structured output is now hardened with a JSON-only contract: no prose before or after the payload, and no Markdown fences like ```json.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/qwen:adversarial-review
/qwen:adversarial-review --base main challenge whether this was the right caching and retry design
/qwen:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/qwen:rescue`

Hands a task to Qwen through the `qwen:qwen-rescue` subagent.

Use it when you want Qwen to:

- investigate a bug
- try a fix
- continue a previous Qwen task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> `/qwen:rescue` now defaults to foreground execution. Use `--background` only when you explicitly want a detached long-running task.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/qwen:rescue investigate why the tests started failing
/qwen:rescue fix the failing test with the smallest safe patch
/qwen:rescue --resume apply the top fix from the last run
/qwen:rescue --model qwen-plus --effort medium investigate the flaky integration test
/qwen:rescue --model qwen-turbo --effort low fix the issue quickly
/qwen:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Qwen:

```text
Ask Qwen to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Qwen Code chooses its own defaults.
- follow-up rescue requests can continue the latest Qwen task in the repo
- if you do not pass `--background`, the rescue run waits in the foreground and returns Qwen's output directly

### `/qwen:status`

Shows running and recent Qwen jobs for the current repository.

Examples:

```bash
/qwen:status
/qwen:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/qwen:result`

Shows the final stored Qwen output for a finished job.
When available, it also includes the Qwen session ID so you can reopen that run directly in Qwen with `qwen resume <session-id>`.

Examples:

```bash
/qwen:result
/qwen:result task-abc123
```

### `/qwen:cancel`

Cancels an active background Qwen job.

Examples:

```bash
/qwen:cancel
/qwen:cancel task-abc123
```

### `/qwen:setup`

Checks whether Qwen Code is installed and configured.
If Qwen Code is missing, it can offer to install it for you.

You can also use `/qwen:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/qwen:setup --enable-review-gate
/qwen:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Qwen review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Qwen loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/qwen:review
```

### Hand A Problem To Qwen

```bash
/qwen:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/qwen:adversarial-review --background
/qwen:rescue --background investigate the flaky test
```

Then check in with:

```bash
/qwen:status
/qwen:result
```

## Qwen Integration

The Qwen plugin wraps the Qwen Code CLI. It uses the global `qwen` binary installed in your environment and applies the same configuration.

The runtime is compatible with both the older ACP `session/*` methods and the newer `thread/*` + `turn/*` methods used by newer Qwen Code releases.

### Common Configurations


Check out the Qwen Code docs for more [configuration options](https://help.aliyun.com/zh/model-studio/qwen-code).

### Moving The Work Over To Qwen

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Qwen by running `qwen resume` either with the specific session ID you received from running `/qwen:result` or `/qwen:status` or by selecting it from the list.

This way you can review the Qwen work or continue the work there.

## FAQ

### Do I need a separate Qwen Code account for this plugin?

If you are already signed into Qwen Code on this machine, that account should work immediately here too. This plugin uses your local Qwen Code CLI authentication.

If you only use Claude Code today and have not used Qwen Code yet, you will also need to sign in to Qwen Code with either an Alibaba Cloud Bailian API key. Run `/qwen:setup` to check whether Qwen Code is ready, and use `!qwen login` if it is not.

### Does the plugin use a separate Qwen runtime?

No. This plugin delegates through your local [Qwen Code CLI](https://help.aliyun.com/zh/model-studio/qwen-code) on the same machine.

That means:

- it uses the same Qwen Code install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Qwen config I already have?

Yes. If you already use Qwen Code, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Qwen Code CLI, your existing sign-in method and config still apply.

If you need to point the provider at a different endpoint, set the appropriate configuration in your [Qwen config](https://help.aliyun.com/zh/model-studio/qwen-code).
