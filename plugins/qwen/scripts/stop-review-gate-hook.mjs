#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getQwenAvailability } from "./lib/qwen.mjs";
import { loadBrokerSession, registerBrokerLease } from "./lib/broker-lifecycle.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getQwenAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Qwen is not set up for the review gate.${detail} Run /qwen:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Qwen review task returned no final output. Run /qwen:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Qwen stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Qwen review task returned an unexpected answer. Run /qwen:review --wait manually or bypass the gate."
  };
}

function runStopReviewTask(cwd, input = {}, extraArgs = []) {
  const scriptPath = path.join(SCRIPT_DIR, "qwen-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  return spawnSync(process.execPath, [scriptPath, "task", "--json", ...extraArgs, prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });
}

function isBrokerTransportFailure(detail) {
  return /broker|shared qwen runtime|upstream ACP session|ECONNREFUSED|ENOENT|Qwen ACP broker connection closed unexpectedly/i.test(
    String(detail ?? "")
  );
}

function parseStopReviewProcessResult(result) {
  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Qwen review task timed out after 2 minutes. Run /qwen:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Qwen review task failed: ${detail}`
        : "The stop-time Qwen review task failed. Run /qwen:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Qwen review task returned invalid JSON. Run /qwen:review --wait manually or bypass the gate."
    };
  }
}

function runStopReview(cwd, input = {}) {
  const brokerSession = loadBrokerSession(cwd);
  if (brokerSession?.endpoint) {
    const sharedResult = runStopReviewTask(cwd, input, ["--require-shared", "--no-start-shared"]);
    if (sharedResult.status === 0) {
      return parseStopReviewProcessResult(sharedResult);
    }

    const sharedDetail = String(sharedResult.stderr || sharedResult.stdout || "").trim();
    if (!isBrokerTransportFailure(sharedDetail)) {
      return parseStopReviewProcessResult(sharedResult);
    }

    logNote("Shared Qwen runtime is unavailable for the stop-time review. Falling back to direct startup.");
  }

  const result = runStopReviewTask(cwd, input, ["--prefer-direct"]);

  return parseStopReviewProcessResult(result);
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  // Claude re-enters Stop hooks after a previous stop hook blocked the stop.
  // Running the stop-time review again would create a feedback loop.
  if (input.stop_hook_active) {
    return;
  }

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Qwen task ${runningJob.id} is still running. Check /qwen:status and use /qwen:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  if (input.session_id) {
    registerBrokerLease(cwd, input.session_id);
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
