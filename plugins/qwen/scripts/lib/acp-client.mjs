/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {{ method: string, params?: Record<string, unknown> }} AcpNotification
 * @typedef {{ clientInfo?: { title?: string, name?: string, version?: string } }} InitializeParams
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { terminateProcessTree } from "./process.mjs";
import { createServerRequestHandler } from "./acp-server-handlers.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

/** ACP 协议版本号 */
const ACP_PROTOCOL_VERSION = 1;
const CLOSE_GRACE_MS = 150;
const CLOSE_TERM_MS = 1000;
const CLOSE_KILL_MS = 1000;

/** @type {{ title: string, name: string, version: string }} */
const DEFAULT_CLIENT_INFO = {
  title: "Qwen Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

function buildInitializeParams(options = {}) {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientInfo: options.clientInfo ?? DEFAULT_CLIENT_INFO,
    capabilities: {}
  };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AcpClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {((notification: AcpNotification) => void) | null} */
    this.notificationHandler = null;
    /** @type {((message: { id: number, method: string, params?: Record<string, unknown> }, client: AcpClientBase) => Promise<void>) | null} */
    this.serverRequestHandler = null;
    this.lineBuffer = "";
    this.transport = "direct";
    /** @type {Map<string, import('./acp-server-handlers.mjs').TerminalSession>} */
    this._terminals = new Map();

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler;
  }

  /**
   * 使用默认的服务器请求处理器（处理权限、文件系统、终端）。
   * 应在 initialize() 之后或手动设置 handler 时调用。
   */
  setupDefaultServerRequestHandler() {
    const handler = createServerRequestHandler(this._terminals);
    this.setServerRequestHandler(async (msg, client) => {
      try {
        await handler(msg, client);
      } catch (err) {
        try { this.respondError(msg.id, -32000, err.message); } catch {}
      }
    });
  }

  /**
   * 响应服务器请求。
   * @param {number} id - 请求 ID
   * @param {Record<string, unknown> | null} result - 响应结果
   */
  respond(id, result) {
    this.sendMessage({ jsonrpc: "2.0", id, result });
  }

  /**
   * 响应服务器请求错误。
   * @param {number} id - 请求 ID
   * @param {number} code - 错误码
   * @param {string} message - 错误消息
   */
  respondError(id, code, message) {
    this.sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /**
   * @template {string} M
   * @param {M} method
   * @param {Record<string, unknown>} params
   * @returns {Promise<Record<string, unknown>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("Qwen ACP client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse Qwen ACP JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `Qwen ACP ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AcpNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    const handler = this.serverRequestHandler;
    if (!handler) {
      this.sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` }
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(message, this))
      .catch((err) => {
        try { this.respondError(message.id, -32000, err.message); } catch {}
      });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("Qwen ACP connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedQwenAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const qwenArgs = ["--acp"];
    if (this.options.model) {
      qwenArgs.push("--model", this.options.model);
    }
    if (this.options.approvalMode) {
      qwenArgs.push("--approval-mode", this.options.approvalMode);
    }

    this.proc = spawn("qwen", qwenArgs, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const detail =
        code === 0
          ? null
          : createProtocolError(`Qwen ACP exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`);
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", buildInitializeParams(this.options));

    // 设置默认的服务器请求处理器（处理权限、文件系统、终端）
    this.setupDefaultServerRequestHandler();
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    // 清理所有终端进程
    for (const term of this._terminals.values()) {
      term.kill();
    }
    this._terminals.clear();

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
    }

    if (await this.waitForExit(CLOSE_GRACE_MS)) {
      this.cleanupProcessHandles();
      return;
    }

    this.tryTerminate("SIGTERM");
    if (await this.waitForExit(CLOSE_TERM_MS)) {
      this.cleanupProcessHandles();
      return;
    }

    this.tryTerminate("SIGKILL");
    if (await this.waitForExit(CLOSE_KILL_MS)) {
      this.cleanupProcessHandles();
      return;
    }

    this.cleanupProcessHandles();
    this.handleExit(createProtocolError("Timed out while shutting down the Qwen ACP process."));
  }

  async waitForExit(timeoutMs) {
    if (this.exitResolved) {
      return true;
    }

    return await Promise.race([
      this.exitPromise.then(() => true),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      })
    ]);
  }

  tryTerminate(signal) {
    if (!this.proc || this.proc.exitCode !== null) {
      return;
    }

    if (signal === "SIGTERM") {
      try {
        terminateProcessTree(this.proc.pid);
        return;
      } catch {
        // Fall back to direct kill below.
      }
    }

    try {
      if (process.platform !== "win32") {
        process.kill(-this.proc.pid, signal);
        return;
      }
    } catch (error) {
      if (error?.code !== "ESRCH") {
        // Fall back to direct kill below.
      } else {
        return;
      }
    }

    try {
      process.kill(this.proc.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }

  cleanupProcessHandles() {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.proc) {
      this.proc.stdout?.destroy();
      this.proc.stderr?.destroy();
      this.proc.stdin?.destroy();
      this.proc.removeAllListeners();
      this.proc.unref?.();
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("Qwen ACP stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokeredQwenAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "shared";
  }

  async initialize() {
    const endpoint = String(this.options.endpoint ?? this.options.brokerEndpoint ?? "").trim();
    if (!endpoint) {
      throw new Error("Broker endpoint is required for shared ACP transport.");
    }

    const target = parseBrokerEndpoint(endpoint);
    const connectSocket = this.options.connectSocket ?? ((connectionTarget) => net.createConnection({ path: connectionTarget.path }));
    this.socket = connectSocket(target);
    this.socket.setEncoding?.("utf8");

    await new Promise((resolve, reject) => {
      let settled = false;
      const onConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.socket.off?.("connect", onConnect);
        this.socket.off?.("error", onError);
      };

      this.socket.on("connect", onConnect);
      this.socket.on("error", onError);
    });

    this.socket.on("data", (chunk) => {
      this.handleChunk(String(chunk));
    });
    this.socket.on("error", (error) => {
      this.handleExit(error);
    });
    this.socket.on("close", () => {
      if (this.exitResolved) {
        return;
      }
      const detail = this.closed ? null : createProtocolError("Qwen ACP broker connection closed unexpectedly.");
      this.handleExit(detail);
    });

    await this.request("initialize", buildInitializeParams(this.options));
    this.setupDefaultServerRequestHandler();
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    for (const term of this._terminals.values()) {
      term.kill();
    }
    this._terminals.clear();

    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }

    await Promise.race([
      this.exitPromise,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, CLOSE_GRACE_MS);
        timer.unref?.();
      })
    ]);

    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.handleExit(null);
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Qwen ACP broker socket is not available.");
    }
    this.socket.write(line);
  }
}

export class AcpClient {
  static async connect(cwd, options = {}) {
    const client =
      options.endpoint || options.brokerEndpoint
        ? new BrokeredQwenAcpClient(cwd, options)
        : new SpawnedQwenAcpClient(cwd, options);
    await client.initialize();
    return client;
  }
}
