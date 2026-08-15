import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  InMemoryAgentRuntime,
  SemanticError,
  type AxiomaticRootBody,
  type PolicyPluginPairV1,
} from "../../src/index.ts";

const ROOT: AxiomaticRootBody = {
  rootPrompt: "sandbox runtime",
  toolDefinitions: [],
};

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/policy-plugins/${name}`, import.meta.url));
}

function plugin(
  name: string,
  kind: "projection" | "adoption",
  options: Record<string, unknown> = {},
) {
  const module = fixture(name);
  return {
    version: "policy-plugin/v1" as const,
    identity: { kind, name: `${kind}-${name}`, version: "v1" },
    module,
    sourceSha256: createHash("sha256").update(readFileSync(module)).digest("hex"),
    ...options,
  };
}

function plugins(
  projection = "complete-path.mjs",
  adoption = "complete-output.mjs",
): PolicyPluginPairV1 {
  return {
    projection: plugin(projection, "projection"),
    adoption: plugin(adoption, "adoption"),
  };
}

function input(runtime: InMemoryAgentRuntime, policyPlugins: PolicyPluginPairV1) {
  return runtime.runWithPolicyPlugins({
    parent: runtime.root().root,
    source: "sandbox-runtime",
    position: 1,
    input: [{ kind: "message", role: "user", content: { text: "hello" } }],
    evaluator: {
      version: "offline-evaluator/v1",
      kind: "constant",
      output: [{ kind: "message", role: "assistant", content: { text: "world" } }],
    },
    policyPlugins,
  });
}

test("arbitrary projection and adoption modules run out of process and append one Node", async () => {
  const runtime = new InMemoryAgentRuntime(ROOT);
  const result = await input(runtime, plugins());
  assert.equal(result.status, "completed");
  assert.equal(result.adoption.decision.kind, "adopt");
  assert.notEqual(result.head, result.parent);
  assert.deepEqual(runtime.path(result.head), [result.parent, result.head]);
  assert.equal(runtime.state().runs.length, 1);
  assert.throws(
    () => runtime.snapshot(),
    (error: unknown) => error instanceof SemanticError &&
      error.code === "AXIOMATIC_POLICY_SANDBOX_SNAPSHOT_UNSUPPORTED",
  );
});

test("sandbox projection timeout leaves no EvaluationOccurrence claim and is retryable", async () => {
  const runtime = new InMemoryAgentRuntime(ROOT);
  await assert.rejects(
    () => input(runtime, {
      projection: plugin("busy.mjs", "projection", { timeoutMs: 100 }),
      adoption: plugin("complete-output.mjs", "adoption"),
    }),
    (error: unknown) => error instanceof SemanticError &&
      error.code === "AXIOMATIC_POLICY_SANDBOX_TIMEOUT",
  );
  assert.equal(runtime.state().ledger.evaluationOccurrences.length, 0);
  const retry = await input(runtime, plugins());
  assert.equal(retry.status, "completed");
});

test("sandbox adoption failure is represented as a deterministic Reject", async () => {
  const runtime = new InMemoryAgentRuntime(ROOT);
  const result = await input(runtime, plugins("complete-path.mjs", "malformed-adoption.mjs"));
  assert.equal(result.status, "completed");
  assert.equal(result.head, result.parent);
  assert.equal(result.adoption.decision.kind, "reject");
  assert.deepEqual(result.adoption.decision.reason, {
    code: "AXIOMATIC_INVALID_SHAPE",
  });
  assert.equal(runtime.state().ledger.nodes.length, 0);
});

test("sandboxed plugin identities include source hash and cannot be silently replaced", async () => {
  const runtime = new InMemoryAgentRuntime(ROOT);
  const first = await input(runtime, plugins());
  const second = await runtime.runWithPolicyPlugins({
    parent: runtime.root().root,
    source: "sandbox-runtime",
    position: 2,
    input: [{ kind: "message", role: "user", content: { text: "different" } }],
    evaluator: { version: "offline-evaluator/v1", kind: "echo" },
    policyPlugins: plugins(),
  });
  assert.notEqual(first.evaluation, second.evaluation);
  assert.ok(second.adoption.policy.includes("sha256:"));
});
