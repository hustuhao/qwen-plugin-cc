import test from "node:test";
import assert from "node:assert/strict";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/qwen/scripts/lib/broker-endpoint.mjs";

test("createBrokerEndpoint uses Unix sockets on non-Windows platforms", () => {
  const endpoint = createBrokerEndpoint("/tmp/qxc-12345", "darwin");
  assert.equal(endpoint, "unix:/tmp/qxc-12345-qwen-acp.sock");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "unix",
    path: "/tmp/qxc-12345-qwen-acp.sock"
  });
});

test("createBrokerEndpoint uses named pipes on Windows", () => {
  const endpoint = createBrokerEndpoint("C:\\\\Temp\\\\qxc-12345", "win32");
  assert.equal(endpoint, "pipe:\\\\.\\pipe\\qxc-12345-qwen-acp");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "pipe",
    path: "\\\\.\\pipe\\qxc-12345-qwen-acp"
  });
});

test("parseBrokerEndpoint rejects unsupported endpoints", () => {
  assert.throws(() => parseBrokerEndpoint("tcp:127.0.0.1:3000"), /Unsupported broker endpoint/);
});
