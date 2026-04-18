export const BROKER_ERROR_CODES = {
  busy: -32001,
  notReady: -32002,
  connectionFailed: -32003,
  requestOwnerGone: -32004,
  invalidState: -32005
};

/**
 * 创建 broker 运行时状态。
 * 这里只维护 broker 自身元数据；真正的 ACP 代理能力在后续阶段接入。
 *
 * @param {{ endpoint: string, cwd: string, pid?: number | null }} options
 */
export function createBrokerState(options) {
  return {
    endpoint: options.endpoint,
    cwd: options.cwd,
    pid: options.pid ?? null,
    status: "ready",
    startedAt: new Date().toISOString(),
    lastRequestAt: null,
    requestCount: 0,
    activeRequest: null,
    ownerClientId: null,
    pendingRequests: new Map(),
    diagnostics: {
      busyCount: 0,
      ownerGoneCount: 0,
      connectionFailedCount: 0,
      invalidStateCount: 0
    }
  };
}

function makeSuccess(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function makeError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message }
  };
}

function makeBrokerError(id, kind, message) {
  switch (kind) {
    case "busy":
      return makeError(id, BROKER_ERROR_CODES.busy, message ?? "broker busy: another client currently owns the upstream ACP session");
    case "not_ready":
      return makeError(id, BROKER_ERROR_CODES.notReady, message ?? "broker not ready");
    case "connection_failed":
      return makeError(id, BROKER_ERROR_CODES.connectionFailed, message ?? "broker connection failed");
    case "request_owner_gone":
      return makeError(id, BROKER_ERROR_CODES.requestOwnerGone, message ?? "broker request owner is gone");
    case "invalid_state":
      return makeError(id, BROKER_ERROR_CODES.invalidState, message ?? "broker internal state is invalid");
    default:
      return makeError(id, -32000, message ?? "broker request failed");
  }
}

/**
 * 创建 broker 请求处理器。
 *
 * 当前仅实现最小控制面协议：
 * - `broker/ping`
 * - `broker/status`
 * - `broker/shutdown`
 *
 * @param {ReturnType<typeof createBrokerState>} state
 * @param {{ onShutdown?: (() => Promise<void> | void) | null }} options
 */
export function createBrokerRequestHandler(state, options = {}) {
  const onShutdown = options.onShutdown ?? null;

  return async function handleBrokerRequest(message) {
    const id = message?.id;
    const method = String(message?.method ?? "");

    if (!Number.isInteger(id)) {
      return makeError(null, -32600, "Broker requests must include an integer id.");
    }

    if (!method) {
      return makeError(id, -32600, "Broker requests must include a method.");
    }

    state.requestCount += 1;
    state.lastRequestAt = new Date().toISOString();

    if (method === "broker/ping") {
      return makeSuccess(id, {
        ok: true,
        status: state.status,
        endpoint: state.endpoint
      });
    }

    if (method === "broker/status") {
      return makeSuccess(id, {
        endpoint: state.endpoint,
        cwd: state.cwd,
        pid: state.pid,
        status: state.status,
        startedAt: state.startedAt,
        lastRequestAt: state.lastRequestAt,
        requestCount: state.requestCount,
        activeRequest: state.activeRequest,
        diagnostics: state.diagnostics
      });
    }

    if (method === "broker/shutdown") {
      state.status = "shutting_down";
      await onShutdown?.();
      return makeSuccess(id, {
        accepted: true,
        status: state.status
      });
    }

    return makeError(id, -32601, `Unsupported broker method: ${method}`);
  };
}

function isBrokerMethod(method) {
  return typeof method === "string" && method.startsWith("broker/");
}

/**
 * 创建 broker ACP 路由器。
 *
 * 路由规则：
 * - `broker/*` 由 broker 本地处理
 * - 非 `broker/*` 请求会绑定当前 owner client
 * - owner client 断开后释放 owner，但不主动关闭上游 ACP
 * - 非 owner client 的 ACP 请求返回 `busy`
 *
 * @param {ReturnType<typeof createBrokerState>} state
 * @param {{
 *   onShutdown?: (() => Promise<void> | void) | null,
 *   ensureUpstream?: (() => Promise<void> | void),
 *   sendToUpstream: ((message: Record<string, unknown>) => Promise<void> | void),
 *   sendToClient: ((clientId: string, message: Record<string, unknown>) => Promise<void> | void)
 * }} options
 */
export function createBrokerRouter(state, options) {
  const localHandler = createBrokerRequestHandler(state, {
    onShutdown: options.onShutdown ?? null
  });

  function setActiveRequest() {
    const next = state.pendingRequests.entries().next();
    state.activeRequest = next.done ? null : { id: next.value[0], method: next.value[1] };
  }

  async function sendLocal(clientId, message) {
    await options.sendToClient(clientId, message);
  }

  async function forwardToUpstream(message) {
    await options.ensureUpstream?.();
    await options.sendToUpstream(message);
  }

  return {
    async handleClientMessage(clientId, message) {
      state.requestCount += 1;
      state.lastRequestAt = new Date().toISOString();

      const method = typeof message?.method === "string" ? message.method : null;
      if (isBrokerMethod(method)) {
        await sendLocal(clientId, await localHandler(message));
        return;
      }

      if (!state.ownerClientId) {
        state.ownerClientId = clientId;
      }

      if (state.ownerClientId !== clientId) {
        if (Number.isInteger(message?.id)) {
          state.diagnostics.busyCount += 1;
          await sendLocal(clientId, makeBrokerError(message.id, "busy"));
        }
        return;
      }

      if (Number.isInteger(message?.id) && method) {
        state.pendingRequests.set(message.id, method);
        setActiveRequest();
      }

      await forwardToUpstream(message);
    },

    async handleUpstreamMessage(message) {
      const ownerClientId = state.ownerClientId;
      if (!ownerClientId) {
        state.diagnostics.ownerGoneCount += 1;
        if (Number.isInteger(message?.id)) {
          state.pendingRequests.delete(message.id);
          setActiveRequest();
        }
        return;
      }

      if (Number.isInteger(message?.id) && !message?.method) {
        state.pendingRequests.delete(message.id);
        setActiveRequest();
      }

      await sendLocal(ownerClientId, message);
    },

    handleClientClose(clientId) {
      if (state.ownerClientId !== clientId) {
        return;
      }
      state.ownerClientId = null;
      state.pendingRequests.clear();
      state.activeRequest = null;
      if (state.status !== "shutting_down") {
        state.status = "ready";
      }
    }
  };
}
