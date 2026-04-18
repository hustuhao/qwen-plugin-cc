/**
 * Qwen ACP client implementation.
 * Protocol: @agentclientprotocol/sdk over NDJSON stdin/stdout.
 *
 * Wire methods (confirmed from qwen-code integration tests):
 *   initialize          { protocolVersion: 1, clientCapabilities: {} }
 *   session/new         { cwd, mcpServers: [] }  → { sessionId }
 *   session/load        { sessionId, cwd, mcpServers: [] }  → {} (resume)
 *   session/set_mode    { sessionId, modeId: 'yolo'|'plan'|'default' }
 *   session/prompt      { sessionId, prompt: [{ type: 'text', text }] }
 *   session/list        { cwd } → { sessions: [{ sessionId, title, ... }] }
 *   cancel              { sessionId }
 *
 * Server → client notifications:
 *   session/update            streaming content: params.update.content.text
 *   session/request_permission  must respond with { outcome: { optionId, outcome } }
 *   fs/read_text_file / fs/write_text_file  filesystem ops
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable } from "./process.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { AcpClient } from "./acp-client.mjs";

const SERVICE_NAME = "claude_code_qwen_plugin";
const TASK_SESSION_PREFIX = "Qwen Companion Task";
const QWEN_SETTINGS_PATH = process.env.QWEN_SETTINGS_PATH || path.join(os.homedir(), ".qwen", "settings.json");
const PROTOCOL_METHOD_NOT_FOUND = -32601;

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function buildTaskSessionName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_SESSION_PREFIX}: ${excerpt}` : TASK_SESSION_PREFIX;
}

function buildTextPart(text) {
  return [{ type: "text", text }];
}

/**
 * @typedef {((message: string | { message: string, phase?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void) | null} ProgressReporter
 */

/**
 * @param {ProgressReporter | null | undefined} onProgress
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) return;
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) return;
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function createSessionState(sessionId, options = {}) {
  let resolveCompletion = () => {};
  return {
    sessionId,
    accumulatedMessage: "",  // all text chunks combined
    lastAgentMessage: "",    // alias for accumulated (qwen-companion expects this)
    reviewText: "",
    reasoningSummary: [],
    messages: [],
    error: null,
    onProgress: options.onProgress ?? null,
    turnId: null,
    turnStatus: null,
    threadLabels: new Map(),
    completionPromise: new Promise((resolve) => {
      resolveCompletion = resolve;
    }),
    resolveCompletion
  };
}

function completeSessionTurn(state, status = "completed") {
  if (state.turnStatus) {
    return;
  }
  state.turnStatus = status;
  state.resolveCompletion(status);
}

function getSubagentLabel(state, threadId) {
  if (!threadId || threadId === state.sessionId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? `Subagent ${threadId}`;
}

function handleSessionUpdateNotification(state, msg) {
  if (msg.method !== "session/update") return false;

  const update = msg.params?.update;
  if (!update) return;

  const updateType = update.sessionUpdate;
  const text = update.content?.text;
  const subagentLabel = update._meta?.subagentLabel ?? null;

  // Reasoning/thought chunks
  if (updateType === "agent_thought_chunk" && typeof text === "string" && text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized && !state.reasoningSummary.includes(normalized)) {
      state.reasoningSummary.push(normalized);
    }
    const logTitle = subagentLabel ? `${subagentLabel} reasoning` : "Reasoning summary";
    const logMsg = subagentLabel
      ? `${subagentLabel} reasoning: ${shorten(normalized, 96)}`
      : `Reasoning summary captured: ${shorten(normalized, 96)}`;
    emitLogEvent(state.onProgress, {
      message: logMsg,
      logTitle,
      logBody: normalized
    });
    return true;
  }

  // Text content from the agent - ACCUMULATE all chunks
  if (typeof text === "string" && text) {
    if (subagentLabel) {
      // Subagent message - log but don't include in main accumulated message
      emitLogEvent(state.onProgress, {
        message: `${subagentLabel}: ${shorten(text, 96)}`,
        logTitle: subagentLabel,
        logBody: text
      });
      return true;
    }
    state.messages.push({ lifecycle: "completed", phase: null, text });
    state.accumulatedMessage += text;
    state.lastAgentMessage = state.accumulatedMessage;
    emitLogEvent(state.onProgress, {
      message: `Assistant: ${shorten(text, 96)}`,
      logTitle: "Assistant message",
      logBody: text
    });
    return true;
  }

  // Progress update (tool calls, usage metadata, etc.)
  if (updateType) {
    emitProgress(state.onProgress, updateType, "investigating");
  }
  return true;
}

function handleThreadProtocolNotification(state, msg) {
  const method = String(msg.method ?? "");
  const threadId = msg.params?.threadId ?? msg.params?.thread?.id ?? null;
  const subagentLabel = getSubagentLabel(state, threadId);

  if (method === "thread/started") {
    const label = msg.params?.thread?.agentNickname ?? msg.params?.thread?.name ?? msg.params?.thread?.id ?? null;
    if (threadId && label) {
      state.threadLabels.set(threadId, label);
    }
    return true;
  }

  if (method === "turn/started") {
    const turnId = msg.params?.turn?.id ?? null;
    if (threadId === state.sessionId && turnId) {
      state.turnId = turnId;
      emitProgress(state.onProgress, `Turn started (${turnId}).`, "starting", { threadId, turnId });
    }
    return true;
  }

  if (method === "turn/completed") {
    if (threadId === state.sessionId) {
      const turnId = msg.params?.turn?.id ?? state.turnId ?? null;
      const status = msg.params?.turn?.status ?? "completed";
      if (turnId) {
        state.turnId = turnId;
      }
      completeSessionTurn(state, status);
    }
    return true;
  }

  if (method !== "item/completed") {
    return false;
  }

  const item = msg.params?.item;
  if (!item || typeof item !== "object") {
    return true;
  }

  if (threadId === state.sessionId && msg.params?.turnId && !state.turnId) {
    state.turnId = msg.params.turnId;
  }

  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary
          .map((entry) => entry?.text ?? "")
          .filter((entry) => typeof entry === "string" && entry.trim())
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
    if (!summary) {
      return true;
    }
    if (!state.reasoningSummary.includes(summary)) {
      state.reasoningSummary.push(summary);
    }
    const logTitle = subagentLabel ? `${subagentLabel} reasoning` : "Reasoning summary";
    const logMsg = subagentLabel
      ? `${subagentLabel} reasoning: ${shorten(summary, 96)}`
      : `Reasoning summary captured: ${shorten(summary, 96)}`;
    emitLogEvent(state.onProgress, {
      message: logMsg,
      logTitle,
      logBody: summary
    });
    return true;
  }

  if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
    if (subagentLabel) {
      emitLogEvent(state.onProgress, {
        message: `${subagentLabel}: ${shorten(item.text, 96)}`,
        logTitle: subagentLabel,
        logBody: item.text
      });
      return true;
    }
    state.messages.push({ lifecycle: "completed", phase: item.phase ?? null, text: item.text });
    state.accumulatedMessage += item.text;
    state.lastAgentMessage = state.accumulatedMessage;
    emitLogEvent(state.onProgress, {
      message: `Assistant: ${shorten(item.text, 96)}`,
      logTitle: "Assistant message",
      logBody: item.text
    });
    return true;
  }

  if (item.type === "exitedReviewMode" && typeof item.review === "string" && item.review) {
    state.reviewText = item.review;
    emitLogEvent(state.onProgress, {
      message: "Review output captured.",
      logTitle: "Review output",
      logBody: item.review
    });
    return true;
  }

  if (item.type) {
    emitProgress(state.onProgress, item.type, "investigating", {
      threadId,
      turnId: msg.params?.turnId ?? null
    });
  }
  return true;
}

function applySessionUpdate(state, msg) {
  if (handleSessionUpdateNotification(state, msg)) {
    return;
  }
  handleThreadProtocolNotification(state, msg);
}

function isUnsupportedMethodError(error, method) {
  if (!error) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  const rpcCode = error?.rpcCode ?? error?.data?.code ?? null;
  if (rpcCode !== PROTOCOL_METHOD_NOT_FOUND) {
    return false;
  }
  return !method || message.includes(method);
}

async function withAcpClient(cwd, fn, options = {}) {
  let client = null;
  try {
    client = await connectPreferredAcpClient(cwd, options);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    if (client) {
      await client.close().catch(() => {});
    }
    throw error;
  }
}

function buildAcpConnectOptions(options = {}) {
  return {
    model: options.model,
    approvalMode: options.approvalMode,
    env: options.env,
    clientInfo: options.clientInfo,
    endpoint: options.endpoint,
    brokerEndpoint: options.brokerEndpoint,
    connectSocket: options.connectSocket
  };
}

async function connectSharedAcpClient(cwd, endpoint, connectOptions, transportHistory) {
  const client = await AcpClient.connect(cwd, {
    ...connectOptions,
    endpoint
  });
  client.connectionMeta = {
    transport: client.transport,
    endpoint,
    fallbackReason: null,
    transportHistory: [
      ...transportHistory,
      {
        transport: client.transport,
        endpoint,
        attemptedAt: new Date().toISOString(),
        fallbackReason: null
      }
    ]
  };
  return client;
}

async function connectPreferredAcpClient(cwd, options = {}) {
  const connectOptions = buildAcpConnectOptions(options);
  const preferShared = options.preferShared !== false;
  const loadBrokerSessionFn = options.loadBrokerSession ?? loadBrokerSession;
  const ensureBrokerSessionFn = options.ensureBrokerSession ?? ensureBrokerSession;
  let brokerSession = preferShared ? loadBrokerSessionFn(cwd) : null;
  /** @type {Array<{ transport: string, endpoint: string | null, attemptedAt: string, fallbackReason: string | null }>} */
  const transportHistory = [];

  if (!brokerSession && preferShared && options.startShared !== false) {
    brokerSession = await ensureBrokerSessionFn(cwd, {
      env: options.env,
      timeoutMs: options.brokerStartTimeoutMs ?? 300
    }).catch(() => null);
  }

  if (brokerSession?.endpoint) {
    try {
      return await connectSharedAcpClient(cwd, brokerSession.endpoint, connectOptions, transportHistory);
    } catch (error) {
      const fallbackReason = error instanceof Error ? error.message : String(error);
      transportHistory.push({
        transport: "shared",
        endpoint: brokerSession.endpoint,
        attemptedAt: new Date().toISOString(),
        fallbackReason
      });

      if (options.startShared !== false) {
        const recoveredBrokerSession = await ensureBrokerSessionFn(cwd, {
          env: options.env,
          timeoutMs: options.brokerStartTimeoutMs ?? 300,
          forceRestart: true
        }).catch(() => null);

        if (recoveredBrokerSession?.endpoint) {
          try {
            return await connectSharedAcpClient(cwd, recoveredBrokerSession.endpoint, connectOptions, transportHistory);
          } catch (recoveryError) {
            transportHistory.push({
              transport: "shared",
              endpoint: recoveredBrokerSession.endpoint,
              attemptedAt: new Date().toISOString(),
              fallbackReason: recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
            });
            if (options.requireShared) {
              throw recoveryError;
            }
          }
        } else if (options.requireShared) {
          throw error;
        }
      }

      emitProgress(
        options.onProgress ?? null,
        "Shared Qwen runtime is unavailable; falling back to direct startup.",
        "starting"
      );
      if (options.requireShared) {
        throw error;
      }
    }
  }

  const client = await AcpClient.connect(cwd, connectOptions);
  client.connectionMeta = {
    transport: client.transport,
    endpoint: null,
    fallbackReason: transportHistory.length > 0 ? transportHistory[transportHistory.length - 1].fallbackReason : null,
    transportHistory: [
      ...transportHistory,
      {
        transport: client.transport,
        endpoint: null,
        attemptedAt: new Date().toISOString(),
        fallbackReason: transportHistory.length > 0 ? transportHistory[transportHistory.length - 1].fallbackReason : null
      }
    ]
  };
  return client;
}

async function startConversation(client, cwd, options = {}) {
  if (options.preferThread) {
    try {
      const response = await client.request("thread/start", {
        cwd,
        ephemeral: options.persistSession === false ? true : false,
        model: options.model ?? null
      });
      const sessionId = response.thread?.id ?? response.threadId ?? null;
      if (!sessionId) {
        throw new Error("Qwen thread/start did not return a thread id.");
      }
      return {
        protocol: "thread",
        sessionId,
        response
      };
    } catch (error) {
      if (!isUnsupportedMethodError(error, "thread/start")) {
        throw error;
      }
    }
  }

  try {
    const response = await client.request("session/new", {
      cwd,
      mcpServers: []
    });
    return {
      protocol: "session",
      sessionId: response.sessionId,
      response
    };
  } catch (error) {
    if (!isUnsupportedMethodError(error, "session/new")) {
      throw error;
    }
  }

  const response = await client.request("thread/start", {
    cwd,
    ephemeral: options.persistSession === false ? true : false,
    model: options.model ?? null
  });
  const sessionId = response.thread?.id ?? response.threadId ?? null;
  if (!sessionId) {
    throw new Error("Qwen thread/start did not return a thread id.");
  }
  return {
    protocol: "thread",
    sessionId,
    response
  };
}

async function resumeConversation(client, cwd, sessionId, options = {}) {
  if (options.preferThread) {
    try {
      await client.request("thread/resume", {
        threadId: sessionId,
        model: options.model ?? null
      });
      return {
        protocol: "thread",
        sessionId
      };
    } catch (error) {
      if (!isUnsupportedMethodError(error, "thread/resume")) {
        throw error;
      }
    }
  }

  try {
    await client.request("session/load", {
      sessionId,
      cwd,
      mcpServers: []
    });
    return {
      protocol: "session",
      sessionId
    };
  } catch (error) {
    if (!isUnsupportedMethodError(error, "session/load")) {
      throw error;
    }
  }

  await client.request("thread/resume", {
    threadId: sessionId,
    model: options.model ?? null
  });
  return {
    protocol: "thread",
    sessionId
  };
}

async function setConversationMode(client, protocol, sessionId, modeId) {
  if (protocol !== "session") {
    return;
  }
  await client.request("session/set_mode", { sessionId, modeId }).catch(() => {});
}

async function setConversationName(client, protocol, sessionId, name) {
  if (!name || protocol !== "thread") {
    return;
  }
  await client.request("thread/name/set", { threadId: sessionId, name }).catch(() => {});
}

async function listConversations(client, cwd) {
  try {
    const response = await client.request("session/list", { cwd, limit: 20 });
    const sessions = response.sessions ?? response.data ?? [];
    return sessions.map((session) => ({
      id: session.sessionId ?? session.id,
      title: session.title ?? session.name ?? ""
    }));
  } catch (error) {
    if (!isUnsupportedMethodError(error, "session/list")) {
      throw error;
    }
  }

  const response = await client.request("thread/list", { cwd, limit: 20 });
  const sessions = response.data ?? response.threads ?? [];
  return sessions.map((session) => ({
    id: session.id ?? session.threadId,
    title: session.name ?? session.title ?? ""
  }));
}

async function runPromptInSession(client, protocol, sessionId, prompt, onProgress, extraParams = {}) {
  const state = createSessionState(sessionId, { onProgress });
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((msg) => {
    applySessionUpdate(state, msg);
  });

  try {
    emitProgress(onProgress, "Sending prompt to Qwen...", "starting");
    if (protocol === "thread") {
      const response = await client.request("turn/start", {
        threadId: sessionId,
        input: buildTextPart(prompt),
        effort: extraParams.effort ?? null,
        model: extraParams.model ?? null,
        outputSchema: extraParams.outputSchema ?? null
      });
      if (response?.turn?.id) {
        state.turnId = response.turn.id;
      }
      await state.completionPromise;
      return { state, response };
    }

    const response = await client.request("session/prompt", {
      sessionId,
      prompt: buildTextPart(prompt),
      ...extraParams
    });
    if (response?.message) {
      state.lastAgentMessage = response.message;
    }
    return { state, response };
  } catch (error) {
    state.error = error;
    return { state, response: null };
  } finally {
    client.setNotificationHandler(previousHandler ?? null);
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function readQwenSettings() {
  try {
    if (fs.existsSync(QWEN_SETTINGS_PATH)) {
      return readJsonFile(QWEN_SETTINGS_PATH);
    }
  } catch {
    // ignore
  }
  return null;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresExternalAuth: null,
    provider: null,
    ...fields
  };
}

function getQwenAuthStatusFromSettings() {
  const settings = readQwenSettings();
  if (!settings) {
    return buildAuthStatus({
      loggedIn: false,
      detail: "Qwen settings not found. Run 'qwen' to set up.",
      source: "settings"
    });
  }

  const authConfig = settings.security?.auth;
  const selectedAuth = authConfig?.selectedType;
  const requiresExternalAuth = authConfig?.requiresExternalAuth;
  const modelName = settings.model?.name ?? "unknown";

  // Provider that doesn't require external auth (e.g. Ollama)
  if (requiresExternalAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${modelName} is configured and does not require external authentication`,
      source: "settings",
      authMethod: null,
      requiresExternalAuth: false
    });
  }

  if (selectedAuth) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `Authenticated via ${selectedAuth}, model: ${modelName}`,
      source: "settings",
      authMethod: selectedAuth,
      verified: true
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: "Qwen authentication not configured",
    source: "settings"
  });
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export function getQwenAvailability(cwd) {
  const versionStatus = binaryAvailable("qwen", ["--version"], { cwd });
  if (!versionStatus.available) return versionStatus;

  const acpStatus = binaryAvailable("qwen", ["--acp", "--help"], { cwd });
  if (!acpStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; ACP runtime unavailable: ${acpStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; ACP runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const brokerSession = loadBrokerSession(cwd);
  if (brokerSession?.endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Qwen runtime.",
      endpoint: brokerSession.endpoint
    };
  }
  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Qwen runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getQwenAuthStatus(cwd, options = {}) {
  const availability = getQwenAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresExternalAuth: null,
      provider: null
    };
  }
  return getQwenAuthStatusFromSettings();
}

export async function interruptAcpSession(cwd, { sessionId, promptId, transport = null, brokerEndpoint = null }) {
  if (!sessionId) {
    return { attempted: false, interrupted: false, detail: "missing sessionId" };
  }

  const availability = getQwenAvailability(cwd);
  if (!availability.available) {
    return { attempted: false, interrupted: false, detail: availability.detail };
  }

  let client = null;
  try {
    client = await connectPreferredAcpClient(cwd, {
      preferShared: transport === "direct" ? false : true,
      startShared: transport === "shared",
      requireShared: transport === "shared",
      brokerEndpoint
    });
    try {
      await client.request("cancel", { sessionId, promptId });
    } catch (error) {
      if (!isUnsupportedMethodError(error, "cancel")) {
        throw error;
      }
      await client.request("turn/interrupt", { threadId: sessionId, turnId: promptId });
    }
    return {
      attempted: true,
      interrupted: true,
      detail: `Cancelled session ${sessionId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

export async function runAcpReview(cwd, options = {}) {
  return withAcpClient(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Qwen review session.", "starting");

    const conversation = await startConversation(client, cwd, {
      model: options.model,
      persistSession: false
    });
    const sessionId = conversation.sessionId;
    emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { threadId: sessionId });

    await setConversationMode(client, conversation.protocol, sessionId, "plan");

    const reviewTarget = options.target;
    let reviewPrompt = "Please review the current code changes and provide a comprehensive code review.";
    if (reviewTarget?.type === "uncommittedChanges") {
      reviewPrompt = "Please review the current uncommitted code changes and provide a comprehensive code review.";
    } else if (reviewTarget?.type === "baseBranch" && reviewTarget.branch) {
      reviewPrompt = `Please review the code changes compared to branch '${reviewTarget.branch}' and provide a comprehensive code review.`;
    }

    let state;
    let promptId = null;
    if (conversation.protocol === "thread") {
      state = createSessionState(sessionId, { onProgress: options.onProgress });
      const previousHandler = client.notificationHandler;
      client.setNotificationHandler((msg) => {
        applySessionUpdate(state, msg);
      });
      try {
        const response = await client.request("review/start", {
          threadId: sessionId,
          target: reviewTarget
        });
        promptId = response?.turn?.id ?? null;
        if (promptId) {
          state.turnId = promptId;
        }
        await state.completionPromise;
      } catch (error) {
        state.error = error;
      } finally {
        client.setNotificationHandler(previousHandler ?? null);
      }
    } else {
      const result = await runPromptInSession(client, conversation.protocol, sessionId, reviewPrompt, options.onProgress);
      state = result.state;
    }

    const reviewText = state.reviewText || state.lastAgentMessage;
    if (reviewText) {
      emitLogEvent(options.onProgress, {
        message: "Review output captured.",
        logTitle: "Review output",
        logBody: reviewText
      });
    }

    return {
      status: state.error ? 1 : 0,
      sessionId,
      transport: client.connectionMeta?.transport ?? client.transport ?? "direct",
      brokerEndpoint: client.connectionMeta?.endpoint ?? null,
      fallbackReason: client.connectionMeta?.fallbackReason ?? null,
      transportHistory: client.connectionMeta?.transportHistory ?? [],
      sourceSessionId: sessionId,
      promptId,
      reviewText,
      reasoningSummary: state.reasoningSummary,
      stderr: client.stderr ?? "",
      error: state.error ?? null
    };
  }, {
    model: options.model,
    env: options.env,
    onProgress: options.onProgress,
    loadBrokerSession: options.loadBrokerSession,
    ensureBrokerSession: options.ensureBrokerSession,
    connectSocket: options.connectSocket,
    startShared: options.startShared,
    brokerStartTimeoutMs: options.brokerStartTimeoutMs
  });
}

export async function runAcpPrompt(cwd, options = {}) {
  return withAcpClient(cwd, async (client) => {
    let sessionId;
    let protocol;

    if (options.resumeSessionId) {
      emitProgress(options.onProgress, `Resuming session ${options.resumeSessionId}.`, "starting");
      const conversation = await resumeConversation(client, cwd, options.resumeSessionId, {
        model: options.model,
        preferThread: Boolean(options.outputSchema)
      });
      sessionId = conversation.sessionId;
      protocol = conversation.protocol;
    } else {
      emitProgress(options.onProgress, "Starting Qwen task session.", "starting");
      const conversation = await startConversation(client, cwd, {
        model: options.model,
        persistSession: options.persistSession !== false,
        preferThread: Boolean(options.outputSchema)
      });
      sessionId = conversation.sessionId;
      protocol = conversation.protocol;
      await setConversationName(client, protocol, sessionId, options.sessionName ?? null);
    }

    emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { threadId: sessionId });

    const modeId = options.sandbox === "workspace-write" ? "yolo" : "default";
    await setConversationMode(client, protocol, sessionId, modeId);

    const prompt = (options.prompt ?? "").trim() || (options.defaultPrompt ?? "").trim();
    if (!prompt) {
      throw new Error("A prompt is required for this Qwen run.");
    }

    // Emit synthetic turnId so background job tracking works
    const syntheticTurnId = `${sessionId}-1`;
    emitProgress(options.onProgress, "Sending prompt to Qwen...", "starting", {
      threadId: sessionId,
      turnId: syntheticTurnId
    });

    const { state } = await runPromptInSession(client, protocol, sessionId, prompt, options.onProgress, {
      effort: options.effort ?? null,
      model: options.model ?? null,
      outputSchema: options.outputSchema ?? null
    });

    return {
      status: state.error ? 1 : 0,
      sessionId,
      transport: client.connectionMeta?.transport ?? client.transport ?? "direct",
      brokerEndpoint: client.connectionMeta?.endpoint ?? null,
      fallbackReason: client.connectionMeta?.fallbackReason ?? null,
      transportHistory: client.connectionMeta?.transportHistory ?? [],
      promptId: state.turnId ?? null,
      finalMessage: state.lastAgentMessage,
      reasoningSummary: state.reasoningSummary,
      error: state.error ?? null,
      stderr: client.stderr ?? "",
      touchedFiles: []
    };
  }, {
    model: options.model,
    env: options.env,
    onProgress: options.onProgress,
    loadBrokerSession: options.loadBrokerSession,
    ensureBrokerSession: options.ensureBrokerSession,
    connectSocket: options.connectSocket,
    startShared: options.startShared,
    brokerStartTimeoutMs: options.brokerStartTimeoutMs
  });
}

export async function findLatestTaskSession(cwd) {
  try {
    return await withAcpClient(cwd, async (client) => {
      const sessions = await listConversations(client, cwd);
      const found = sessions.find(
        (s) => typeof s.title === "string" && s.title.startsWith(TASK_SESSION_PREFIX)
      );
      if (!found) return null;
      return { id: found.id };
    }, {
      startShared: true
    });
  } catch {
    return null;
  }
}

export function buildPersistentTaskSessionName(prompt) {
  return buildTaskSessionName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Qwen did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }
  try {
    return { parsed: JSON.parse(rawOutput), parseError: null, rawOutput, ...fallback };
  } catch (error) {
    return { parsed: null, parseError: error.message, rawOutput, ...fallback };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { TASK_SESSION_PREFIX };
