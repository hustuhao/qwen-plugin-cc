import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeQwen(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-qwen-state.json");
  const scriptPath = path.join(binDir, "qwen");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

	const STATE_PATH = ${JSON.stringify(statePath)};
	const BEHAVIOR = ${JSON.stringify(behavior)};
	const interruptibleTurns = new Map();

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null };
	  }
	  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-qwen",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress", error = null) {
  return { id, status, items: [], error };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresExternalAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresExternalAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresExternalAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresExternalAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function emitTurnCompleted(threadId, turnId, item) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-internal-error") {
      return null;
    }
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

function getModelId() {
  switch (BEHAVIOR) {
    case "api-key-account-only": return "gpt-4(apiKey)";
    case "provider-no-auth": return "llama(ollama)";
    case "env-key-provider": return "custom(openai-custom)";
    default: return "coder-model(qwen-oauth)";
  }
}

function emitAcpResponse(msgId, sessionId, prompt, outputSchema) {
  const state = loadState();
  let payload;
  const isStructuredReview = (outputSchema && outputSchema.properties && outputSchema.properties.verdict) ||
    prompt.includes("adversarial software review");
  const isNativeReview = !isStructuredReview && prompt.includes("comprehensive code review");

  if (isStructuredReview) {
    payload = structuredReviewPayload(prompt);
  } else if (isNativeReview) {
    // Native review: detect target type from prompt
    if (prompt.includes("compared to branch '")) {
      const match = prompt.match(/compared to branch '([^']+)'/);
      const branch = match ? match[1] : "main";
      payload = "Reviewed changes against " + branch + ".\\nNo material issues found.";
    } else {
      payload = "Reviewed uncommitted changes.\\nNo material issues found.";
    }
  } else {
    const sessions = state.threads || [];
    const isResume = sessions.some(function(t) { return t.name && t.name.startsWith("Qwen Companion Task"); }) &&
      (prompt.includes("Continue from the current session state") || prompt.includes("follow up"));
    payload = taskPayload(prompt, isResume);
  }

  // Reasoning for review (with-reasoning behavior)
  if (BEHAVIOR === "with-reasoning") {
    const reasoningText = isNativeReview
      ? "Reviewed the changed files and checked the likely regression paths."
      : "Inspected the prompt, gathered evidence, and checked the highest-risk paths first.";
    send({ method: "session/update", params: { sessionId: sessionId, update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: reasoningText }
    }}});
  }

  if (BEHAVIOR === "with-subagent" || BEHAVIOR === "with-late-subagent-message" || BEHAVIOR === "with-subagent-no-main-turn-completed") {
    send({ method: "session/update", params: { sessionId: sessionId, update: {
      sessionUpdate: "Starting subagent design-challenger via collaboration tool: wait."
    }}});
    send({ method: "session/update", params: { sessionId: sessionId, update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Questioned the retry strategy and the cache invalidation boundaries." },
      _meta: { subagentLabel: "Subagent design-challenger" }
    }}});
    send({ method: "session/update", params: { sessionId: sessionId, update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees." },
      _meta: { subagentLabel: "Subagent design-challenger" }
    }}});
  }

  if (BEHAVIOR !== "with-late-subagent-message") {
    send({ method: "session/update", params: { sessionId: sessionId, update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: payload }
    }}});
  } else {
    // with-late-subagent-message: main message was already sent before subagent
    send({ method: "session/update", params: { sessionId: sessionId, update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: payload }
    }}});
  }

  send({ method: "session/update", params: { sessionId: sessionId, update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "" },
    _meta: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
  }}});

  send({ id: msgId, result: { stopReason: "end_turn" } });
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("qwen-cli test");
  process.exit(0);
}
if (args[0] === "--acp" && args[1] === "--help") {
  console.log("fake acp help");
  process.exit(0);
}

function findFlagValue(argList, flagNames) {
  for (var i = 0; i < argList.length; i++) {
    if (flagNames.indexOf(argList[i]) !== -1) {
      return argList[i + 1] || "";
    }
  }
  return null;
}

var headlessPrompt = findFlagValue(args, ["-p", "--prompt"]);
if (headlessPrompt !== null) {
  var headlessState = loadState();
  headlessState.lastHeadlessRun = {
    prompt: headlessPrompt,
    args: args,
    approvalMode: findFlagValue(args, ["--approval-mode"]),
    model: findFlagValue(args, ["-m", "--model"])
  };
  saveState(headlessState);

  if (BEHAVIOR === "headless-error") {
    process.stderr.write("headless mode failed\\n");
    process.exit(1);
  }

  process.stdout.write("Headless mode handled the task via qwen -p.\\n");
  process.exit(0);
}
if (args[0] === "--acp") {
  const state = loadState();
  state.appServerStarts = (state.appServerStarts || 0) + 1;
  saveState(state);

  if (BEHAVIOR === "hang-on-close") {
    setInterval(function() {}, 1000);
    process.on("SIGTERM", function() {});
  }

  let nextSessionId = 1;
  var pendingCancels = new Map();

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", function(line) {
    if (!line.trim()) return;
    var message;
    try { message = JSON.parse(line); } catch(e) { return; }
    var state = loadState();

    switch (message.method) {
      case "initialize":
        send({ id: message.id, result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-qwen", title: "Fake Qwen", version: "0.0.1" },
          authMethods: [{ id: "openai", name: "Use OpenAI API key" }],
          agentCapabilities: { loadSession: true }
        }});
        break;

      case "session/new": {
        if (BEHAVIOR === "thread-protocol") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: session/new. Expected one of thread/start, thread/resume, turn/start." } });
          break;
        }
        if (BEHAVIOR === "auth-run-fails") {
          send({ id: message.id, error: { code: -32000, message: "authentication expired; run qwen login" } });
          break;
        }
        var sessionId = "thr_" + nextSessionId++;
        state.threads = state.threads || [];
        state.threads.unshift({ id: sessionId, cwd: message.params.cwd || process.cwd(), name: null });
        state.nextThreadId = nextSessionId;
        saveState(state);
        send({ id: message.id, result: {
          sessionId: sessionId,
          models: { currentModelId: getModelId(), availableModels: [] },
          modes: { currentModeId: "default", availableModes: [] },
          configOptions: []
        }});
        break;
      }

      case "session/load": {
        if (BEHAVIOR === "thread-protocol") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: session/load. Expected one of thread/start, thread/resume." } });
          break;
        }
        if (BEHAVIOR === "auth-run-fails") {
          send({ id: message.id, error: { code: -32000, message: "authentication expired; run qwen login" } });
          break;
        }
        send({ id: message.id, result: {
          models: { currentModelId: getModelId(), availableModels: [] },
          modes: { currentModeId: "default", availableModes: [] },
          configOptions: []
        }});
        break;
      }

      case "session/set_mode":
        if (BEHAVIOR === "thread-protocol") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: session/set_mode" } });
          break;
        }
        send({ id: message.id, result: {} });
        break;

      case "session/prompt": {
        if (BEHAVIOR === "thread-protocol") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: session/prompt. Expected one of turn/start, review/start." } });
          break;
        }
        var sessionId2 = message.params.sessionId;
        var prompt = (message.params.prompt || []).filter(function(p) { return p.type === "text"; }).map(function(p) { return p.text; }).join("\\n");
        var outputSchema = message.params.outputSchema;

        if (BEHAVIOR === "schema-prefers-thread" && outputSchema) {
          send({ id: message.id, error: { code: -32603, message: "Internal error", data: { details: "Connection error." } } });
          break;
        }

        var session = (state.threads || []).find(function(t) { return t.id === sessionId2; });
        if (session && !session.name) {
          session.name = "Qwen Companion Task: " + prompt.slice(0, 56);
        }
        state.lastTurnStart = { threadId: sessionId2, prompt: prompt, model: message.params.model || null, effort: message.params.effort || null };
        saveState(state);

        if (BEHAVIOR === "interruptible-slow-task") {
          send({ method: "session/update", params: { sessionId: sessionId2, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } } } });
          var msgId = message.id;
          var timer = setTimeout(function() {
            if (pendingCancels.has(msgId)) return;
            emitAcpResponse(msgId, sessionId2, prompt, outputSchema);
          }, 5000);
          pendingCancels.set(msgId, { timer: timer, sessionId: sessionId2 });
          break;
        }

        if (BEHAVIOR === "adversarial-internal-error" && ((outputSchema && outputSchema.properties && outputSchema.properties.verdict) || prompt.includes("adversarial software review"))) {
          send({ method: "session/update", params: { sessionId: sessionId2, update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "I need to inspect the implementation details before I can finalize the adversarial review." }
          }}});
          send({ id: message.id, error: { code: -32000, message: "Internal error" } });
          break;
        }

        if (BEHAVIOR === "acp-task-internal-error") {
          send({ id: message.id, error: { code: -32603, message: "Internal error", data: { details: "ACP runtime failure" } } });
          break;
        }

        if (BEHAVIOR === "slow-task") {
          var msgId2 = message.id;
          setTimeout(function() {
            emitAcpResponse(msgId2, sessionId2, prompt, outputSchema);
          }, 400);
          break;
        }

        emitAcpResponse(message.id, sessionId2, prompt, outputSchema);
        break;
      }

      case "cancel": {
        if (BEHAVIOR === "thread-protocol") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: cancel. Expected turn/interrupt." } });
          break;
        }
        for (var entry of pendingCancels) {
          if (entry[1].sessionId === message.params.sessionId) {
            clearTimeout(entry[1].timer);
            pendingCancels.delete(entry[0]);
            send({ id: entry[0], result: { stopReason: "cancelled" } });
            break;
          }
        }
        state.lastInterrupt = { threadId: message.params.sessionId, turnId: message.params.promptId || null };
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "session/list": {
        if (BEHAVIOR === "thread-protocol") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: session/list. Expected thread/list." } });
          break;
        }
        var sessions = (state.threads || []).map(function(t) {
          return { sessionId: t.id, title: t.name || "(session)", cwd: t.cwd, updatedAt: new Date().toISOString() };
        });
        send({ id: message.id, result: { sessions: sessions } });
        break;
      }

      case "thread/start": {
        if (BEHAVIOR !== "thread-protocol" && BEHAVIOR !== "schema-prefers-thread") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
          break;
        }
        var thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4" } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        if (BEHAVIOR !== "thread-protocol" && BEHAVIOR !== "schema-prefers-thread") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
          break;
        }
        var namedThread = ensureThread(state, message.params.threadId);
        namedThread.name = message.params.name;
        namedThread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        if (BEHAVIOR !== "thread-protocol" && BEHAVIOR !== "schema-prefers-thread") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
          break;
        }
        var threads = (state.threads || []).slice();
        if (message.params.cwd) {
          threads = threads.filter(function(threadCandidate) { return threadCandidate.cwd === message.params.cwd; });
        }
        threads.sort(function(left, right) { return right.updatedAt - left.updatedAt; });
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (BEHAVIOR !== "thread-protocol" && BEHAVIOR !== "schema-prefers-thread") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
          break;
        }
        var resumedThread = ensureThread(state, message.params.threadId);
        resumedThread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(resumedThread), model: message.params.model || "gpt-5.4" } });
        break;
      }

      case "review/start": {
        if (BEHAVIOR !== "thread-protocol" && BEHAVIOR !== "schema-prefers-thread") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
          break;
        }
        var reviewThread = ensureThread(state, message.params.threadId);
        var reviewTurnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(reviewTurnId), reviewThreadId: reviewThread.id } });
        emitTurnCompleted(reviewThread.id, reviewTurnId, [
          {
            completed: { type: "exitedReviewMode", id: reviewTurnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

      case "turn/start": {
        if (BEHAVIOR !== "thread-protocol" && BEHAVIOR !== "schema-prefers-thread") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
          break;
        }
        var promptThread = ensureThread(state, message.params.threadId);
        var threadPrompt = (message.params.input || []).filter(function(item) { return item.type === "text"; }).map(function(item) { return item.text; }).join("\\n");
        var turnId = nextTurnId(state);
        promptThread.updatedAt = now();
        state.lastTurnStart = {
          threadId: message.params.threadId,
          turnId: turnId,
          model: message.params.model || null,
          effort: message.params.effort || null,
          prompt: threadPrompt
        };
        saveState(state);
        send({ id: message.id, result: { turn: buildTurn(turnId) } });

        var payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(threadPrompt)
          : taskPayload(threadPrompt, promptThread.name && promptThread.name.startsWith("Qwen Companion Task") && threadPrompt.includes("Continue from the current thread state"));

        emitTurnCompleted(promptThread.id, turnId, [
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ]);
        break;
      }

      case "turn/interrupt": {
        if (BEHAVIOR !== "thread-protocol" && BEHAVIOR !== "schema-prefers-thread") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
          break;
        }
        state.lastInterrupt = {
          threadId: message.params.threadId,
          turnId: message.params.turnId
        };
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      default:
        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
    }
  });
  return;
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
const bootState = loadState();
bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
saveState(bootState);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  const state = loadState();

  try {
    switch (message.method) {
      case "initialize":
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-qwen-app-server" } });
        break;

      case "initialized":
        break;

      case "account/read":
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run qwen login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        break;
      }

      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          prompt
	        };
	        saveState(state);
	        send({ id: message.id, result: { turn: buildTurn(turnId) } });

        const payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : taskPayload(prompt, thread.name && thread.name.startsWith("Qwen Companion Task") && prompt.includes("Continue from the current thread state"));

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        const items = [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ];

	        if (BEHAVIOR === "interruptible-slow-task") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          const timer = setTimeout(() => {
	            if (!interruptibleTurns.has(turnId)) {
	              return;
	            }
	            interruptibleTurns.delete(turnId);
	            for (const entry of items) {
	              if (entry && entry.completed) {
	                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	              }
	            }
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 5000);
	          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
	        } else if (BEHAVIOR === "slow-task") {
	          emitTurnCompletedLater(thread.id, turnId, items, 400);
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "turn/interrupt": {
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (pending) {
	          clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`;
  writeExecutable(scriptPath, source);

  // Create fake settings.json for auth testing via QWEN_SETTINGS_PATH
  const settingsPath = path.join(binDir, "qwen-settings.json");
  const settings = buildFakeSettings(behavior);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a qwen.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0qwen" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "qwen.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

function buildFakeSettings(behavior) {
  switch (behavior) {
    case "api-key-account-only":
      return { security: { auth: { selectedType: "apiKey" } }, model: { name: "gpt-4" } };
    case "provider-no-auth":
      return { security: { auth: { requiresExternalAuth: false } }, model: { name: "llama" } };
    case "env-key-provider":
      return { security: { auth: { requiresExternalAuth: false } }, model: { name: "OpenAI custom" } };
    case "logged-out":
    case "config-read-fails":
      return {};
    case "refreshable-auth":
    case "auth-run-fails":
      return { security: { auth: { selectedType: "openai" } }, model: { name: "gpt-4o" } };
    default:
      return { security: { auth: { selectedType: "chatgpt" } }, model: { name: "gpt-4o" } };
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`,
    QWEN_SETTINGS_PATH: path.join(binDir, "qwen-settings.json")
  };
}
