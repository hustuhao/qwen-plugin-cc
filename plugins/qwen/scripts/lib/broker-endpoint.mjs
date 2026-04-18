import path from "node:path";

export function createBrokerEndpoint(sessionDir, platform = process.platform) {
  const slug =
    (platform === "win32" ? path.win32 : path.posix)
      .basename(String(sessionDir ?? ""))
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "qwen-broker";

  if (platform === "win32") {
    return `pipe:\\\\.\\pipe\\${slug}-qwen-acp`;
  }

  return `unix:${path.join("/tmp", `${slug}-qwen-acp.sock`)}`;
}

export function parseBrokerEndpoint(endpoint) {
  const value = String(endpoint ?? "").trim();
  if (value.startsWith("unix:")) {
    return { kind: "unix", path: value.slice("unix:".length) };
  }
  if (value.startsWith("pipe:")) {
    return { kind: "pipe", path: value.slice("pipe:".length) };
  }
  throw new Error(`Unsupported broker endpoint "${value}".`);
}
