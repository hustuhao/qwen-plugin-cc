import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir } from "./state.mjs";

/**
 * Broker 端点环境变量名。
 */
export const BROKER_ENDPOINT_ENV = "QWEN_COMPANION_ACP_ENDPOINT";

const BROKER_STATE_FILE = "broker.json";

export const LOG_FILE_ENV = "QWEN_COMPANION_BROKER_LOG_FILE";
export const PID_FILE_ENV = "QWEN_COMPANION_BROKER_PID_FILE";
export const DEFAULT_BROKER_LEASE_TTL_MS = 30 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function normalizeOwners(owners) {
  if (!Array.isArray(owners)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const owner of owners) {
    const sessionId = String(owner?.sessionId ?? "").trim();
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    normalized.push({
      sessionId,
      lastSeenAt: typeof owner?.lastSeenAt === "string" && owner.lastSeenAt ? owner.lastSeenAt : nowIso()
    });
  }
  return normalized;
}

function isOwnerExpired(owner, nowMs, maxAgeMs) {
  const lastSeenAt = Date.parse(owner?.lastSeenAt ?? "");
  if (!Number.isFinite(lastSeenAt)) {
    return true;
  }
  return nowMs - lastSeenAt > maxAgeMs;
}

function normalizeBrokerSession(session) {
  if (!session || typeof session !== "object") {
    return null;
  }

  return {
    endpoint: session.endpoint ?? null,
    pidFile: session.pidFile ?? null,
    logFile: session.logFile ?? null,
    sessionDir: session.sessionDir ?? null,
    pid: session.pid ?? null,
    owners: normalizeOwners(session.owners),
    createdAt: typeof session.createdAt === "string" && session.createdAt ? session.createdAt : nowIso(),
    updatedAt: typeof session.updatedAt === "string" && session.updatedAt ? session.updatedAt : nowIso()
  };
}

export function createBrokerSessionDir(prefix = "qxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return normalizeBrokerSession(JSON.parse(fs.readFileSync(stateFile, "utf8")));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const normalized = normalizeBrokerSession({
    ...session,
    updatedAt: nowIso()
  });
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

async function isBrokerEndpointReady(endpoint, waitForReady = waitForBrokerEndpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForReady(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const waitForReady = options.waitForBrokerEndpoint ?? waitForBrokerEndpoint;
  const startBroker = options.spawnBrokerProcess ?? spawnBrokerProcess;
  const cleanupBrokerSession = options.teardownBrokerSession ?? teardownBrokerSession;
  const forceRestart = options.forceRestart === true;
  const existing = loadBrokerSession(cwd);
  if (!forceRestart && existing && (await isBrokerEndpointReady(existing.endpoint, waitForReady))) {
    return existing;
  }

  if (existing) {
    cleanupBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../qwen-acp-broker.mjs", import.meta.url));

  const child = startBroker({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForReady(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    cleanupBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    owners: existing?.owners ?? [],
    createdAt: existing?.createdAt ?? nowIso()
  };
  saveBrokerSession(cwd, session);
  return loadBrokerSession(cwd);
}

export function registerBrokerLease(cwd, sessionId) {
  const normalizedSessionId = String(sessionId ?? "").trim();
  if (!normalizedSessionId) {
    return loadBrokerSession(cwd);
  }

  const current = loadBrokerSession(cwd) ?? {
    endpoint: null,
    pidFile: null,
    logFile: null,
    sessionDir: null,
    pid: null,
    owners: [],
    createdAt: nowIso()
  };
  const owners = normalizeOwners(current.owners);
  const existingOwner = owners.find((owner) => owner.sessionId === normalizedSessionId);
  if (existingOwner) {
    existingOwner.lastSeenAt = nowIso();
  } else {
    owners.push({
      sessionId: normalizedSessionId,
      lastSeenAt: nowIso()
    });
  }
  saveBrokerSession(cwd, {
    ...current,
    owners
  });
  return loadBrokerSession(cwd);
}

export function releaseBrokerLease(cwd, sessionId) {
  const current = loadBrokerSession(cwd);
  if (!current) {
    return null;
  }

  const normalizedSessionId = String(sessionId ?? "").trim();
  const owners = normalizeOwners(current.owners).filter((owner) => owner.sessionId !== normalizedSessionId);
  if (!current.endpoint && !current.pidFile && !current.logFile && !current.sessionDir && owners.length === 0) {
    clearBrokerSession(cwd);
    return null;
  }

  saveBrokerSession(cwd, {
    ...current,
    owners
  });
  return loadBrokerSession(cwd);
}

export function pruneBrokerLeases(cwd, options = {}) {
  const current = loadBrokerSession(cwd);
  if (!current) {
    return null;
  }

  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? Math.max(0, options.maxAgeMs) : DEFAULT_BROKER_LEASE_TTL_MS;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const owners = normalizeOwners(current.owners).filter((owner) => !isOwnerExpired(owner, nowMs, maxAgeMs));

  if (owners.length === current.owners.length) {
    return current;
  }

  if (!current.endpoint && !current.pidFile && !current.logFile && !current.sessionDir && owners.length === 0) {
    clearBrokerSession(cwd);
    return null;
  }

  saveBrokerSession(cwd, {
    ...current,
    owners
  });
  return loadBrokerSession(cwd);
}

/**
 * 清理 broker 会话资源。
 * @param {{ endpoint?: string | null, pidFile?: string | null, logFile?: string | null, sessionDir?: string | null, pid?: number | null, killProcess?: Function }?} options
 */
export function teardownBrokerSession(options = {}) {
  const { endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null } = options ?? {};
  if (pid && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  for (const filePath of [pidFile, logFile]) {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore missing files during cleanup.
      }
    }
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed endpoints.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
