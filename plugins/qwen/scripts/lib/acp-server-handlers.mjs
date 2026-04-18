/**
 * ACP 服务器请求处理器。
 *
 * 处理来自 qwen --acp 服务器的请求，包括：
 * - 权限请求 (session/request_permission)
 * - 文件系统操作 (fs/read_text_file, fs/write_text_file)
 * - 终端会话管理 (terminal/*)
 */

import fs from "node:fs";
import { spawn } from "node:child_process";
import { terminateProcessTree } from "./process.mjs";

// ---------------------------------------------------------------------------
// 终端会话管理
// ---------------------------------------------------------------------------

let _terminalIdCounter = 0;

/**
 * 终端会话类。
 * 管理由服务器请求创建的子进程。
 */
export class TerminalSession {
  /**
   * @param {{ command: string, args?: string[], cwd?: string, env?: Array<{ name: string, value?: string }>, outputByteLimit?: number }} params
   */
  constructor(params) {
    this.id = `term-${++_terminalIdCounter}-${Date.now()}`;
    this.output = "";
    this.exitCode = null;
    this.exitSignal = null;
    this.outputByteLimit = params.outputByteLimit ?? 1024 * 1024;
    this.truncated = false;

    /** @type {(value: { exitCode: number, signal: NodeJS.Signals | null }) => void} */
    this._exitResolve;
    /** @type {Promise<{ exitCode: number, signal: NodeJS.Signals | null }>} */
    this.exitPromise = new Promise((resolve) => {
      this._exitResolve = resolve;
    });

    const env = {};
    for (const e of (params.env ?? [])) {
      if (e?.name) env[e.name] = e.value ?? "";
    }

    try {
      const child = spawn(params.command, params.args ?? [], {
        cwd: params.cwd || process.cwd(),
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true
      });

      this.proc = child;

      /** @param {Buffer | string} chunk */
      const onData = (chunk) => {
        const str = chunk.toString();
        if (this.output.length < this.outputByteLimit) {
          this.output += str;
          if (this.output.length > this.outputByteLimit) {
            this.output = this.output.slice(0, this.outputByteLimit);
            this.truncated = true;
          }
        } else {
          this.truncated = true;
        }
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      child.on("exit", (code, signal) => {
        this.exitCode = code ?? -1;
        this.exitSignal = signal ?? null;
        if (this._exitResolve) {
          this._exitResolve({ exitCode: this.exitCode, signal: this.exitSignal });
        }
      });

      child.on("error", (err) => {
        this.output += `\nSpawn error: ${err.message}`;
        this.exitCode = -1;
        if (this._exitResolve) {
          this._exitResolve({ exitCode: -1, signal: null });
        }
      });
    } catch (err) {
      this.output = `Spawn error: ${err.message}`;
      this.exitCode = -1;
      if (this._exitResolve) {
        this._exitResolve({ exitCode: -1, signal: null });
      }
    }
  }

  /**
   * 获取终端输出和退出状态。
   * @returns {{ output: string, truncated: boolean, exitStatus: { exitCode: number, signal: NodeJS.Signals | null } | null }}
   */
  getOutput() {
    return {
      output: this.output,
      truncated: this.truncated,
      exitStatus: this.exitCode !== null
        ? { exitCode: this.exitCode, signal: this.exitSignal }
        : null
    };
  }

  /** 终止终端进程。 */
  kill() {
    if (this.proc && this.exitCode === null) {
      try { terminateProcessTree(this.proc.pid); } catch { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// 默认服务器请求处理器
// ---------------------------------------------------------------------------

/**
 * 创建默认的服务器请求处理器。
 *
 * 处理的方法：
 * - `session/request_permission` — 自动回复 proceed_once
 * - `fs/read_text_file` — 读取文件内容
 * - `fs/write_text_file` — 写入文件内容
 * - `terminal/create` — 创建终端会话
 * - `terminal/output` — 获取终端输出
 * - `terminal/wait_for_exit` — 等待进程退出
 * - `terminal/kill` — 终止终端进程
 * - `terminal/release` — 释放终端会话
 *
 * @param {Map<string, TerminalSession>} terminals - 终端会话映射
 * @returns {(msg: { id: number, method: string, params?: Record<string, unknown> }, client: { respond: Function, respondError: Function }) => Promise<void>}
 */
export function createServerRequestHandler(terminals) {
  /**
   * @param {{ id: number, method: string, params?: { path?: string, content?: string, terminalId?: string, command?: string, args?: string[], cwd?: string, env?: Array<{ name: string, value?: string }>, outputByteLimit?: number } }} msg
   * @param {{ respond: Function, respondError: Function }} client
   */
  return async function handleServerRequest(msg, client) {
    const method = msg.method;
    const params = msg.params ?? {};

    if (method === "session/request_permission") {
      client.respond(msg.id, {
        outcome: { optionId: "proceed_once", outcome: "selected" }
      });
      return;
    }

    if (method === "fs/read_text_file") {
      try {
        const filePath = /** @type {string} */ (params.path ?? "");
        const content = fs.readFileSync(filePath, "utf8");
        client.respond(msg.id, { content });
      } catch (e) {
        client.respond(msg.id, { content: `ERROR: ${e.message}` });
      }
      return;
    }

    if (method === "fs/write_text_file") {
      try {
        const filePath = /** @type {string} */ (params.path ?? "");
        const content = /** @type {string} */ (params.content ?? "");
        fs.writeFileSync(filePath, content, "utf8");
        client.respond(msg.id, null);
      } catch (e) {
        client.respondError(msg.id, -32000, e.message);
      }
      return;
    }

    if (method === "terminal/create") {
      const term = new TerminalSession(/** @type {{ command: string, args?: string[], cwd?: string, env?: Array<{ name: string, value?: string }>, outputByteLimit?: number }} */ (params));
      terminals.set(term.id, term);
      client.respond(msg.id, { terminalId: term.id });
      return;
    }

    if (method === "terminal/output") {
      const terminalId = /** @type {string} */ (params.terminalId);
      const term = terminals.get(terminalId);
      if (!term) {
        client.respond(msg.id, { output: "", truncated: false, exitStatus: { exitCode: -1, signal: null } });
        return;
      }
      client.respond(msg.id, term.getOutput());
      return;
    }

    if (method === "terminal/wait_for_exit") {
      const terminalId = /** @type {string} */ (params.terminalId);
      const term = terminals.get(terminalId);
      if (!term) {
        client.respond(msg.id, { exitCode: -1, signal: null });
        return;
      }
      const result = await term.exitPromise;
      client.respond(msg.id, result);
      return;
    }

    if (method === "terminal/kill") {
      const terminalId = /** @type {string} */ (params.terminalId);
      const term = terminals.get(terminalId);
      if (term) term.kill();
      client.respond(msg.id, {});
      return;
    }

    if (method === "terminal/release") {
      const terminalId = /** @type {string} */ (params.terminalId);
      const term = terminals.get(terminalId);
      if (term) {
        term.kill();
        terminals.delete(terminalId);
      }
      client.respond(msg.id, {});
      return;
    }

    // Unknown server request
    client.respondError(msg.id, -32601, `Unsupported server request: ${method}`);
  };
}
