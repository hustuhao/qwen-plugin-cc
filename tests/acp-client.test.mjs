import assert from "node:assert/strict";
import EventEmitter from "node:events";
import test from "node:test";

import { AcpClient } from "../plugins/qwen/scripts/lib/acp-client.mjs";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = [];
  }

  setEncoding() {}

  write(chunk) {
    this.writes.push(chunk);
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

test("AcpClient uses broker socket transport when endpoint is provided", async () => {
  const socket = new FakeSocket();
  const notifications = [];

  const clientPromise = AcpClient.connect("/repo", {
    endpoint: "unix:/tmp/qwen-broker.sock",
    connectSocket() {
      process.nextTick(() => {
        socket.emit("connect");
      });
      return socket;
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  process.nextTick(() => {
    const initialize = JSON.parse(String(socket.writes[0]).trim());
    socket.emit("data", `${JSON.stringify({
      id: initialize.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake-broker", version: "0.0.1" },
        agentCapabilities: {}
      }
    })}\n`);
  });

  const client = await clientPromise;
  assert.equal(client.transport, "shared");
  client.setNotificationHandler((message) => {
    notifications.push(message.method);
  });

  const sessionPromise = client.request("session/new", { cwd: "/repo", mcpServers: [] });
  const sessionRequest = JSON.parse(socket.writes[1].trim());
  socket.emit("data", `${JSON.stringify({
    method: "session/update",
    params: { sessionId: "thr_1", update: { sessionUpdate: "agent_message_chunk" } }
  })}\n`);
  socket.emit("data", `${JSON.stringify({
    id: sessionRequest.id,
    result: { sessionId: "thr_1" }
  })}\n`);

  const response = await sessionPromise;
  assert.deepEqual(response, { sessionId: "thr_1" });
  assert.deepEqual(notifications, ["session/update"]);

  client.setServerRequestHandler(async (message, brokerClient) => {
    brokerClient.respond(message.id, { ok: true, method: message.method });
  });
  socket.emit("data", `${JSON.stringify({
    id: 99,
    method: "fs/read_text_file",
    params: { path: "/tmp/demo.txt" }
  })}\n`);

  await new Promise((resolve) => setImmediate(resolve));
  const serverResponse = JSON.parse(socket.writes[2].trim());
  assert.deepEqual(serverResponse, {
    jsonrpc: "2.0",
    id: 99,
    result: { ok: true, method: "fs/read_text_file" }
  });

  await client.close();
});
