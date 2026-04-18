import test from "node:test";
import assert from "node:assert/strict";

import {
  BROKER_ERROR_CODES,
  createBrokerRouter,
  createBrokerRequestHandler,
  createBrokerState
} from "../plugins/qwen/scripts/lib/qwen-acp-broker-core.mjs";

test("broker/ping returns broker liveness information", async () => {
  const state = createBrokerState({
    endpoint: "unix:/tmp/qxc-test.sock",
    cwd: "/repo",
    pid: 4321
  });
  const handleRequest = createBrokerRequestHandler(state);

  const response = await handleRequest({
    id: 1,
    method: "broker/ping"
  });

  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      ok: true,
      status: "ready",
      endpoint: "unix:/tmp/qxc-test.sock"
    }
  });
});

test("broker/status returns broker metadata", async () => {
  const state = createBrokerState({
    endpoint: "unix:/tmp/qxc-test.sock",
    cwd: "/repo",
    pid: 4321
  });
  const handleRequest = createBrokerRequestHandler(state);

  await handleRequest({ id: 1, method: "broker/ping" });
  const response = await handleRequest({
    id: 2,
    method: "broker/status"
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 2);
  assert.equal(response.result.endpoint, "unix:/tmp/qxc-test.sock");
  assert.equal(response.result.cwd, "/repo");
  assert.equal(response.result.pid, 4321);
  assert.equal(response.result.status, "ready");
  assert.equal(response.result.requestCount, 2);
  assert.equal(typeof response.result.startedAt, "string");
  assert.equal(typeof response.result.lastRequestAt, "string");
  assert.deepEqual(response.result.diagnostics, {
    busyCount: 0,
    ownerGoneCount: 0,
    connectionFailedCount: 0,
    invalidStateCount: 0
  });
});

test("broker/shutdown marks the broker shutting down and runs cleanup", async () => {
  const state = createBrokerState({
    endpoint: "unix:/tmp/qxc-test.sock",
    cwd: "/repo"
  });
  let shutdownCalls = 0;
  const handleRequest = createBrokerRequestHandler(state, {
    onShutdown() {
      shutdownCalls += 1;
    }
  });

  const response = await handleRequest({
    id: 3,
    method: "broker/shutdown"
  });

  assert.equal(shutdownCalls, 1);
  assert.equal(state.status, "shutting_down");
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 3,
    result: {
      accepted: true,
      status: "shutting_down"
    }
  });
});

test("unsupported broker methods return method-not-found", async () => {
  const state = createBrokerState({
    endpoint: "unix:/tmp/qxc-test.sock",
    cwd: "/repo"
  });
  const handleRequest = createBrokerRequestHandler(state);

  const response = await handleRequest({
    id: 4,
    method: "broker/unknown"
  });

  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 4,
    error: {
      code: -32601,
      message: "Unsupported broker method: broker/unknown"
    }
  });
});

test("broker router forwards ACP traffic for the owner client", async () => {
  const state = createBrokerState({
    endpoint: "unix:/tmp/qxc-test.sock",
    cwd: "/repo"
  });
  const upstreamMessages = [];
  const clientMessages = [];
  let ensureCalls = 0;
  const router = createBrokerRouter(state, {
    async ensureUpstream() {
      ensureCalls += 1;
    },
    async sendToUpstream(message) {
      upstreamMessages.push(message);
    },
    async sendToClient(clientId, message) {
      clientMessages.push({ clientId, message });
    }
  });

  await router.handleClientMessage("client-a", {
    id: 1,
    method: "session/new",
    params: { cwd: "/repo", mcpServers: [] }
  });

  assert.equal(state.ownerClientId, "client-a");
  assert.equal(state.activeRequest.method, "session/new");
  assert.equal(ensureCalls, 1);
  assert.deepEqual(upstreamMessages, [
    {
      id: 1,
      method: "session/new",
      params: { cwd: "/repo", mcpServers: [] }
    }
  ]);

  await router.handleUpstreamMessage({
    method: "session/update",
    params: { sessionId: "thr_1", update: { sessionUpdate: "agent_message_chunk" } }
  });
  await router.handleUpstreamMessage({
    id: 1,
    result: { sessionId: "thr_1" }
  });

  assert.equal(state.activeRequest, null);
  assert.deepEqual(clientMessages, [
    {
      clientId: "client-a",
      message: {
        method: "session/update",
        params: { sessionId: "thr_1", update: { sessionUpdate: "agent_message_chunk" } }
      }
    },
    {
      clientId: "client-a",
      message: {
        id: 1,
        result: { sessionId: "thr_1" }
      }
    }
  ]);
});

test("broker router rejects non-owner ACP requests while busy", async () => {
  const state = createBrokerState({
    endpoint: "unix:/tmp/qxc-test.sock",
    cwd: "/repo"
  });
  const clientMessages = [];
  const router = createBrokerRouter(state, {
    async ensureUpstream() {},
    async sendToUpstream() {},
    async sendToClient(clientId, message) {
      clientMessages.push({ clientId, message });
    }
  });

  await router.handleClientMessage("client-a", {
    id: 1,
    method: "session/new",
    params: { cwd: "/repo", mcpServers: [] }
  });
  await router.handleClientMessage("client-b", {
    id: 2,
    method: "session/list",
    params: { cwd: "/repo" }
  });

  assert.deepEqual(clientMessages, [
    {
      clientId: "client-b",
      message: {
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: BROKER_ERROR_CODES.busy,
          message: "broker busy: another client currently owns the upstream ACP session"
        }
      }
    }
  ]);
  assert.equal(state.diagnostics.busyCount, 1);
});

test("broker router releases owner on client close", async () => {
  const state = createBrokerState({
    endpoint: "unix:/tmp/qxc-test.sock",
    cwd: "/repo"
  });
  const router = createBrokerRouter(state, {
    async ensureUpstream() {},
    async sendToUpstream() {},
    async sendToClient() {}
  });

  await router.handleClientMessage("client-a", {
    id: 1,
    method: "session/new",
    params: { cwd: "/repo", mcpServers: [] }
  });
  router.handleClientClose("client-a");

  assert.equal(state.ownerClientId, null);
  assert.equal(state.activeRequest, null);
  assert.equal(state.pendingRequests.size, 0);

  await router.handleClientMessage("client-b", {
    id: 2,
    method: "session/list",
    params: { cwd: "/repo" }
  });
  assert.equal(state.ownerClientId, "client-b");
});

test("broker router drops late upstream messages after the owner disconnects", async () => {
  const state = createBrokerState({
    endpoint: "unix:/tmp/qxc-test.sock",
    cwd: "/repo"
  });
  const clientMessages = [];
  const router = createBrokerRouter(state, {
    async ensureUpstream() {},
    async sendToUpstream() {},
    async sendToClient(clientId, message) {
      clientMessages.push({ clientId, message });
    }
  });

  await router.handleClientMessage("client-a", {
    id: 1,
    method: "session/new",
    params: { cwd: "/repo", mcpServers: [] }
  });

  router.handleClientClose("client-a");

  await router.handleUpstreamMessage({
    id: 1,
    result: { sessionId: "thr_late" }
  });
  await router.handleUpstreamMessage({
    method: "session/update",
    params: { sessionId: "thr_late", update: { sessionUpdate: "agent_message_chunk" } }
  });

  assert.equal(state.ownerClientId, null);
  assert.equal(state.activeRequest, null);
  assert.equal(state.pendingRequests.size, 0);
  assert.deepEqual(clientMessages, []);
  assert.equal(state.diagnostics.ownerGoneCount, 2);
});
