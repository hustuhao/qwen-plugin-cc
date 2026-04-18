import assert from "node:assert/strict";
import EventEmitter from "node:events";
import test from "node:test";

import { runAcpPrompt } from "../plugins/qwen/scripts/lib/qwen.mjs";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = [];
  }

  setEncoding() {}

  write(chunk) {
    this.writes.push(chunk);
    const message = JSON.parse(String(chunk).trim());

    if (message.method === "initialize") {
      process.nextTick(() => {
        this.emit("data", `${JSON.stringify({
          id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "fake-broker", version: "0.0.1" },
            agentCapabilities: {}
          }
        })}\n`);
      });
    }

    if (message.method === "session/new") {
      process.nextTick(() => {
        this.emit("data", `${JSON.stringify({
          id: message.id,
          result: { sessionId: "thr_1" }
        })}\n`);
      });
    }

    if (message.method === "session/set_mode") {
      process.nextTick(() => {
        this.emit("data", `${JSON.stringify({
          id: message.id,
          result: {}
        })}\n`);
      });
    }

    if (message.method === "session/prompt") {
      process.nextTick(() => {
        this.emit("data", `${JSON.stringify({
          method: "session/update",
          params: {
            sessionId: "thr_1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Handled the requested task.\nTask prompt accepted." }
            }
          }
        })}\n`);
        this.emit("data", `${JSON.stringify({
          id: message.id,
          result: { stopReason: "end_turn" }
        })}\n`);
      });
    }

    return true;
  }

  end() {
    this.destroyed = true;
    this.emit("close");
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

class FakeThreadSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = [];
  }

  setEncoding() {}

  write(chunk) {
    this.writes.push(chunk);
    const message = JSON.parse(String(chunk).trim());

    if (message.method === "initialize") {
      process.nextTick(() => {
        this.emit("data", `${JSON.stringify({
          id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "fake-broker", version: "0.0.1" },
            agentCapabilities: {}
          }
        })}\n`);
      });
    }

    if (message.method === "session/new") {
      process.nextTick(() => {
        this.emit("data", `${JSON.stringify({
          id: message.id,
          error: { code: -32601, message: "Unsupported method: session/new. Expected one of thread/start, thread/resume." }
        })}\n`);
      });
    }

    if (message.method === "thread/start") {
      process.nextTick(() => {
        this.emit("data", `${JSON.stringify({
          id: message.id,
          result: { thread: { id: "thr_thread_1" } }
        })}\n`);
        this.emit("data", `${JSON.stringify({
          method: "thread/started",
          params: { thread: { id: "thr_thread_1" } }
        })}\n`);
      });
    }

    if (message.method === "thread/name/set") {
      process.nextTick(() => {
        this.emit("data", `${JSON.stringify({ id: message.id, result: {} })}\n`);
      });
    }

    if (message.method === "turn/start") {
      process.nextTick(() => {
        this.emit("data", `${JSON.stringify({
          id: message.id,
          result: { turn: { id: "turn_1", status: "inProgress" } }
        })}\n`);
        this.emit("data", `${JSON.stringify({
          method: "turn/started",
          params: { threadId: "thr_thread_1", turn: { id: "turn_1", status: "inProgress" } }
        })}\n`);
        this.emit("data", `${JSON.stringify({
          method: "item/completed",
          params: {
            threadId: "thr_thread_1",
            turnId: "turn_1",
            item: { type: "agentMessage", id: "msg_turn_1", text: "Handled the requested task.\nTask prompt accepted.", phase: "final_answer" }
          }
        })}\n`);
        this.emit("data", `${JSON.stringify({
          method: "turn/completed",
          params: { threadId: "thr_thread_1", turn: { id: "turn_1", status: "completed" } }
        })}\n`);
      });
    }

    return true;
  }

  end() {
    this.destroyed = true;
    this.emit("close");
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

test("runAcpPrompt lazily starts a shared broker session and uses shared transport", async () => {
  const socket = new FakeSocket();
  const progress = [];
  const ensureCalls = [];

  const result = await runAcpPrompt("/repo", {
    prompt: "challenge the current design",
    onProgress(event) {
      progress.push(event);
    },
    loadBrokerSession() {
      return null;
    },
    async ensureBrokerSession(cwd, options) {
      ensureCalls.push({ cwd, timeoutMs: options.timeoutMs });
      return { endpoint: "unix:/tmp/qwen-broker.sock" };
    },
    connectSocket() {
      process.nextTick(() => {
        socket.emit("connect");
      });
      return socket;
    }
  });

  assert.equal(ensureCalls.length, 1);
  assert.equal(ensureCalls[0].cwd, "/repo");
  assert.equal(typeof ensureCalls[0].timeoutMs, "number");
  assert.equal(result.sessionId, "thr_1");
  assert.equal(result.finalMessage, "Handled the requested task.\nTask prompt accepted.");
  assert.equal(progress.some((entry) => {
    if (typeof entry === "string") {
      return false;
    }
    return entry.threadId === "thr_1";
  }), true);
});

test("runAcpPrompt restarts the shared broker once when the saved shared endpoint cannot be connected", async () => {
  const progress = [];
  const ensureCalls = [];
  const sockets = new Map();
  sockets.set("restarted.sock", new FakeSocket());

  const result = await runAcpPrompt("/repo", {
    prompt: "challenge the current design",
    onProgress(event) {
      progress.push(event);
    },
    loadBrokerSession() {
      return { endpoint: "unix:/tmp/stale.sock" };
    },
    async ensureBrokerSession(cwd, options) {
      ensureCalls.push({ cwd, forceRestart: options.forceRestart === true });
      return { endpoint: "unix:/tmp/restarted.sock" };
    },
    connectSocket(target) {
      const socket = sockets.get(target.path.split("/").pop());
      if (!socket) {
        const erroring = new EventEmitter();
        erroring.setEncoding = () => {};
        process.nextTick(() => {
          erroring.emit("error", new Error(`connect ENOENT ${target.path}`));
        });
        return erroring;
      }
      process.nextTick(() => {
        socket.emit("connect");
      });
      return socket;
    }
  });

  assert.equal(ensureCalls.length, 1);
  assert.equal(ensureCalls[0].cwd, "/repo");
  assert.equal(ensureCalls[0].forceRestart, true);
  assert.equal(result.sessionId, "thr_1");
  assert.equal(result.transport, "shared");
  assert.equal(result.finalMessage, "Handled the requested task.\nTask prompt accepted.");
  assert.equal(progress.some((entry) => {
    if (typeof entry === "string") {
      return false;
    }
    return entry.threadId === "thr_1";
  }), true);
});

test("runAcpPrompt falls back to thread protocol when session/new is unsupported", async () => {
  const socket = new FakeThreadSocket();

  const result = await runAcpPrompt("/repo", {
    prompt: "challenge the current design",
    loadBrokerSession() {
      return { endpoint: "unix:/tmp/qwen-broker.sock" };
    },
    connectSocket() {
      process.nextTick(() => {
        socket.emit("connect");
      });
      return socket;
    }
  });

  assert.equal(result.sessionId, "thr_thread_1");
  assert.equal(result.promptId, "turn_1");
  assert.equal(result.finalMessage, "Handled the requested task.\nTask prompt accepted.");
  assert.equal(socket.writes.some((chunk) => JSON.parse(String(chunk).trim()).method === "thread/start"), true);
  assert.equal(socket.writes.some((chunk) => JSON.parse(String(chunk).trim()).method === "turn/start"), true);
});
