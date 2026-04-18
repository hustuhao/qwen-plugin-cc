import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createBrokerSessionDir,
  DEFAULT_BROKER_LEASE_TTL_MS,
  ensureBrokerSession,
  loadBrokerSession,
  pruneBrokerLeases,
  registerBrokerLease,
  releaseBrokerLease,
  saveBrokerSession,
  teardownBrokerSession
} from "../plugins/qwen/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint } from "../plugins/qwen/scripts/lib/broker-endpoint.mjs";
import { makeTempDir } from "./helpers.mjs";

test("createBrokerSessionDir creates a temporary broker directory", () => {
  const sessionDir = createBrokerSessionDir("qwen-broker-test-");
  assert.equal(fs.existsSync(sessionDir), true);
  assert.match(path.basename(sessionDir), /^qwen-broker-test-/);
  fs.rmdirSync(sessionDir);
});

test("ensureBrokerSession spawns, saves, and reuses a healthy broker", async () => {
  const repo = makeTempDir();
  const spawnCalls = [];
  const readyEndpoints = new Set();
  const cleanupCalls = [];
  let nextPid = 3000;

  const session = await ensureBrokerSession(repo, {
    scriptPath: "/tmp/fake-broker.mjs",
    timeoutMs: 10,
    spawnBrokerProcess({ endpoint, pidFile, logFile, sessionDir }) {
      readyEndpoints.add(endpoint);
      spawnCalls.push({ endpoint, pidFile, logFile, sessionDir });
      return { pid: nextPid++ };
    },
    async waitForBrokerEndpoint(endpoint) {
      return readyEndpoints.has(endpoint);
    },
    teardownBrokerSession(options) {
      cleanupCalls.push(options);
    }
  });

  assert.ok(session);
  assert.equal(typeof session.endpoint, "string");
  assert.equal(spawnCalls.length, 1);
  assert.equal(cleanupCalls.length, 0);

  const saved = loadBrokerSession(repo);
  assert.equal(saved.endpoint, session.endpoint);

  const reused = await ensureBrokerSession(repo, {
    scriptPath: "/tmp/fake-broker.mjs",
    timeoutMs: 10,
    spawnBrokerProcess({ endpoint }) {
      spawnCalls.push({ endpoint });
      return { pid: nextPid++ };
    },
    async waitForBrokerEndpoint(endpoint) {
      return readyEndpoints.has(endpoint);
    },
    teardownBrokerSession(options) {
      cleanupCalls.push(options);
    }
  });
  assert.equal(reused.endpoint, session.endpoint);
  assert.equal(spawnCalls.length, 1);
  assert.equal(cleanupCalls.length, 0);
});

test("ensureBrokerSession cleans up when broker never becomes ready", async () => {
  const repo = makeTempDir();
  const missingScript = path.join(repo, "missing-broker.mjs");
  const session = await ensureBrokerSession(repo, {
    scriptPath: missingScript,
    timeoutMs: 200
  });

  assert.equal(session, null);
  assert.equal(loadBrokerSession(repo), null);
});

test("ensureBrokerSession forceRestart replaces an existing broker even when it is healthy", async () => {
  const repo = makeTempDir();
  const readyEndpoints = new Set(["unix:/tmp/existing-broker.sock"]);
  const spawnCalls = [];
  const cleanupCalls = [];

  saveBrokerSession(repo, {
    endpoint: "unix:/tmp/existing-broker.sock",
    pidFile: "/tmp/existing-broker.pid",
    logFile: "/tmp/existing-broker.log",
    sessionDir: "/tmp/existing-broker",
    pid: 1111,
    owners: [],
    createdAt: "2026-04-12T00:00:00.000Z"
  });

  const session = await ensureBrokerSession(repo, {
    forceRestart: true,
    spawnBrokerProcess({ endpoint, pidFile, logFile, sessionDir }) {
      readyEndpoints.add(endpoint);
      spawnCalls.push({ endpoint, pidFile, logFile, sessionDir });
      return { pid: 2222 };
    },
    async waitForBrokerEndpoint(endpoint) {
      return readyEndpoints.has(endpoint);
    },
    teardownBrokerSession(options) {
      cleanupCalls.push(options);
    }
  });

  assert.ok(session);
  assert.equal(spawnCalls.length, 1);
  assert.equal(cleanupCalls.length, 1);
  assert.notEqual(session.endpoint, "unix:/tmp/existing-broker.sock");
});

test("teardownBrokerSession removes unix socket and metadata files", () => {
  const sessionDir = makeTempDir();
  const endpoint = createBrokerEndpoint(sessionDir, "darwin");
  const socketPath = endpoint.slice("unix:".length);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");

  fs.writeFileSync(socketPath, "", "utf8");
  fs.writeFileSync(pidFile, "123\n", "utf8");
  fs.writeFileSync(logFile, "log\n", "utf8");

  teardownBrokerSession({
    endpoint,
    pidFile,
    logFile,
    sessionDir
  });

  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(logFile), false);
});

test("registerBrokerLease and releaseBrokerLease track workspace session owners", () => {
  const repo = makeTempDir();

  const first = registerBrokerLease(repo, "sess-a");
  assert.deepEqual(first.owners.map((owner) => owner.sessionId), ["sess-a"]);
  assert.equal(first.endpoint, null);

  const second = registerBrokerLease(repo, "sess-b");
  assert.deepEqual(second.owners.map((owner) => owner.sessionId).sort(), ["sess-a", "sess-b"]);

  const refreshed = registerBrokerLease(repo, "sess-a");
  assert.deepEqual(refreshed.owners.map((owner) => owner.sessionId).sort(), ["sess-a", "sess-b"]);

  const remaining = releaseBrokerLease(repo, "sess-a");
  assert.deepEqual(remaining.owners.map((owner) => owner.sessionId), ["sess-b"]);

  const cleared = releaseBrokerLease(repo, "sess-b");
  assert.equal(cleared, null);
  assert.equal(loadBrokerSession(repo), null);
});

test("pruneBrokerLeases removes expired owners and preserves fresh ones", () => {
  const repo = makeTempDir();
  const nowMs = Date.parse("2026-04-12T12:00:00.000Z");
  saveBrokerSession(repo, {
    endpoint: "unix:/tmp/fake-broker.sock",
    pidFile: "/tmp/fake-broker.pid",
    logFile: "/tmp/fake-broker.log",
    sessionDir: "/tmp/fake-broker-session",
    pid: 1234,
    owners: [
      {
        sessionId: "sess-stale",
        lastSeenAt: new Date(nowMs - DEFAULT_BROKER_LEASE_TTL_MS - 1000).toISOString()
      },
      {
        sessionId: "sess-fresh",
        lastSeenAt: new Date(nowMs - 5000).toISOString()
      }
    ],
    createdAt: "2026-04-12T11:00:00.000Z"
  });

  const pruned = pruneBrokerLeases(repo, { nowMs });
  assert.ok(pruned);
  assert.deepEqual(pruned.owners.map((owner) => owner.sessionId), ["sess-fresh"]);
  assert.equal(pruned.endpoint, "unix:/tmp/fake-broker.sock");
});

test("pruneBrokerLeases clears lease-only state when every owner is expired", () => {
  const repo = makeTempDir();
  const nowMs = Date.parse("2026-04-12T12:00:00.000Z");

  saveBrokerSession(repo, {
    endpoint: null,
    pidFile: null,
    logFile: null,
    sessionDir: null,
    pid: null,
    owners: [
      {
        sessionId: "sess-stale",
        lastSeenAt: new Date(nowMs - DEFAULT_BROKER_LEASE_TTL_MS - 1000).toISOString()
      }
    ],
    createdAt: "2026-04-12T11:00:00.000Z"
  });

  const pruned = pruneBrokerLeases(repo, { nowMs });
  assert.equal(pruned, null);
  assert.equal(loadBrokerSession(repo), null);
});
