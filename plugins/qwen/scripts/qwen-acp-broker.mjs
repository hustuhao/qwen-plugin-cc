#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";

import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { createBrokerRouter, createBrokerState } from "./lib/qwen-acp-broker-core.mjs";

const CLOSE_GRACE_MS = 150;
const CLOSE_TERM_MS = 1000;
const CLOSE_KILL_MS = 1000;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command: command ?? "" };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    args[token.slice(2)] = rest[index + 1] ?? "";
    index += 1;
  }
  return args;
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function createJsonlConnection(socket, handleRequest) {
  socket.setEncoding("utf8");
  let buffer = "";

  socket.on("data", async (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        socket.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON payload." }
        })}\n`);
        continue;
      }

      try {
        const response = await handleRequest(message);
        if (response) {
          socket.write(`${JSON.stringify(response)}\n`);
        }
      } catch (error) {
        socket.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: Number.isInteger(message?.id) ? message.id : null,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error)
          }
        })}\n`);
      }
    }
  });
}

function spawnQwenAcp(cwd, env = process.env) {
  const proc = spawn("qwen", ["--acp"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  return proc;
}

async function waitForExit(proc, exitPromise, timeoutMs) {
  if (!proc || proc.exitCode !== null) {
    return true;
  }
  return await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    })
  ]);
}

function tryTerminate(proc, signal) {
  if (!proc || proc.exitCode !== null) {
    return;
  }

  if (signal === "SIGTERM") {
    try {
      terminateProcessTree(proc.pid);
      return;
    } catch {
      // Fall through to direct kill.
    }
  }

  try {
    if (process.platform !== "win32") {
      process.kill(-proc.pid, signal);
      return;
    }
  } catch (error) {
    if (error?.code === "ESRCH") {
      return;
    }
  }

  try {
    process.kill(proc.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

async function closeUpstream(proc, readlineInterface) {
  if (!proc) {
    return;
  }

  const exitPromise = new Promise((resolve) => {
    proc.once("exit", () => resolve());
  });

  readlineInterface?.close();
  proc.stdin?.end();
  if (await waitForExit(proc, exitPromise, CLOSE_GRACE_MS)) {
    return;
  }

  tryTerminate(proc, "SIGTERM");
  if (await waitForExit(proc, exitPromise, CLOSE_TERM_MS)) {
    return;
  }

  tryTerminate(proc, "SIGKILL");
  await waitForExit(proc, exitPromise, CLOSE_KILL_MS);
}

async function runServeCommand(args) {
  const endpoint = String(args.endpoint ?? "").trim();
  const cwd = String(args.cwd ?? process.cwd());
  const pidFile = String(args["pid-file"] ?? "").trim() || null;

  if (!endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  writePidFile(pidFile);

  const target = parseBrokerEndpoint(endpoint);
  if (target.kind === "unix" && fs.existsSync(target.path)) {
    fs.unlinkSync(target.path);
  }

  let server = null;
  let shuttingDown = false;
  let nextClientId = 1;
  let upstreamProc = null;
  let upstreamReadline = null;
  const state = createBrokerState({
    endpoint,
    cwd,
    pid: process.pid
  });

  const cleanup = () => {
    if (target.kind === "unix" && fs.existsSync(target.path)) {
      try {
        fs.unlinkSync(target.path);
      } catch {
        // Ignore cleanup races during shutdown.
      }
    }
  };

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    state.status = "shutting_down";
    await closeUpstream(upstreamProc, upstreamReadline);
    upstreamProc = null;
    upstreamReadline = null;
    await new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    cleanup();
    process.exit(0);
  };

  const sockets = new Map();
  const router = createBrokerRouter(state, {
    onShutdown: shutdown,
    async ensureUpstream() {
      if (upstreamProc && upstreamProc.exitCode === null) {
        return;
      }

      state.status = "busy";
      upstreamProc = spawnQwenAcp(cwd, process.env);
      upstreamProc.stderr.on("data", (chunk) => {
        process.stderr.write(String(chunk));
      });
      upstreamProc.on("exit", () => {
        upstreamProc = null;
        upstreamReadline = null;
        if (!shuttingDown) {
          state.status = state.ownerClientId ? "busy" : "ready";
        }
      });

      upstreamReadline = readline.createInterface({ input: upstreamProc.stdout });
      upstreamReadline.on("line", (line) => {
        if (!line.trim()) {
          return;
        }
        try {
          void router.handleUpstreamMessage(JSON.parse(line));
        } catch (error) {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        }
      });
    },
    async sendToUpstream(message) {
      if (!upstreamProc?.stdin) {
        throw new Error("Upstream ACP stdin is not available.");
      }
      upstreamProc.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async sendToClient(clientId, message) {
      const socket = sockets.get(clientId);
      if (socket && !socket.destroyed) {
        socket.write(`${JSON.stringify(message)}\n`);
      }
    }
  });

  server = net.createServer((socket) => {
    const clientId = `client-${nextClientId++}`;
    sockets.set(clientId, socket);
    socket.on("close", () => {
      sockets.delete(clientId);
      router.handleClientClose(clientId);
    });
    createJsonlConnection(socket, async (message) => {
      await router.handleClientMessage(clientId, message);
      return null;
    });
  });

  server.on("error", (error) => {
    cleanup();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("exit", cleanup);

  await new Promise((resolve, reject) => {
    server.listen(target.path, () => resolve());
    server.once("error", reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "serve") {
    throw new Error("Usage: qwen-acp-broker.mjs serve --endpoint <endpoint> [--cwd <cwd>] [--pid-file <pidFile>]");
  }

  await runServeCommand(args);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
