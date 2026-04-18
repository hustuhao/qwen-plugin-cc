import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/qwen/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Qwen returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Qwen Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Qwen Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Qwen Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Qwen session ID: thr_123/);
  assert.match(output, /Resume in Qwen: qwen --resume thr_123/);
});

test("renderStoredJobResult includes transport metadata when present", () => {
  const output = renderStoredJobResult(
    {
      id: "task-123",
      status: "completed",
      title: "Qwen Task",
      jobClass: "task",
      summary: "Investigate flaky worker timeout",
      errorMessage: "No captured result payload was stored for this job.",
      threadId: "thr_task_123"
    },
    null
  );

  assert.match(output, /^# Qwen Task/);
  assert.match(output, /Job: task-123/);
  assert.match(output, /Status: completed/);
  assert.match(output, /Qwen session ID: thr_task_123/);
  assert.match(output, /Resume in Qwen: qwen --resume thr_task_123/);
  assert.match(output, /Summary: Investigate flaky worker timeout/);
});
