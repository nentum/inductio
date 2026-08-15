import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SemanticError,
  effectivePolicyIdentity,
  executePolicyPlugin,
  normalizePolicyPlugin,
  type PolicyPluginV1,
  type ProjectionPolicyInput,
} from "../../src/index.ts";
import { expectCode } from "../helpers/expect-code.ts";

const projectionInput: ProjectionPolicyInput = {
  root: {
    agent: "sha256:" + "1".repeat(64),
    root: "sha256:" + "2".repeat(64),
    body: { rootPrompt: "sandbox", toolDefinitions: [] },
  },
  parent: "sha256:" + "2".repeat(64),
  path: [
    {
      kind: "root",
      ref: "sha256:" + "2".repeat(64),
      body: { rootPrompt: "sandbox", toolDefinitions: [] },
    },
  ],
  candidateInput: { text: "input" },
  environment: { version: 1 },
  endpoint: { model: "offline" },
  explicitInputs: null,
};

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/policy-plugins/${name}`, import.meta.url));
}

function plugin(
  name: string,
  kind: "projection" | "adoption",
  options: Partial<PolicyPluginV1> = {},
): PolicyPluginV1 {
  const module = fixture(name);
  return {
    version: "policy-plugin/v1",
    identity: { kind, name: `${kind}-${name}`, version: "v1" },
    module,
    sourceSha256: createHash("sha256").update(readFileSync(module)).digest("hex"),
    ...options,
  };
}

function expectSandboxCode(action: () => Promise<unknown>, codes: readonly string[]): Promise<void> {
  return assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof SemanticError);
    assert.ok(codes.includes(error.code), `${error.code} not in ${codes.join(", ")}`);
    return true;
  });
}

test("policy plugin module hash, identity, and resource bounds are validated", () => {
  const spec = plugin("complete-path.mjs", "projection");
  const normalized = normalizePolicyPlugin(spec, "projection");
  assert.equal(normalized.exportName, null);
  assert.equal(normalized.timeoutMs, 5_000);
  assert.equal(normalized.memoryLimitMb, 128);
  assert.equal(normalized.sourceSha256, spec.sourceSha256);
  assert.match(effectivePolicyIdentity(normalized).version, /sandbox=node-vm-policy-sandbox\/v1/);

  expectCode(
    () => normalizePolicyPlugin({ ...spec, sourceSha256: "0".repeat(64) }, "projection"),
    "AXIOMATIC_POLICY_SANDBOX_MODULE_HASH",
  );
  expectCode(
    () => normalizePolicyPlugin({ ...spec, module: "relative.mjs" }, "projection"),
    "AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC",
  );
  expectCode(
    () => normalizePolicyPlugin({ ...spec, timeoutMs: 60_001 }, "projection"),
    "AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC",
  );
  expectCode(
    () => normalizePolicyPlugin({ ...spec, memoryLimitMb: 8 }, "projection"),
    "AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC",
  );
});

test("caller-forged normalized plugins are revalidated before spawn", async () => {
  const normalized = normalizePolicyPlugin(plugin("complete-path.mjs", "projection"), "projection");
  await expectSandboxCode(
    () => executePolicyPlugin({
      ...normalized,
      identity: { ...normalized.identity, kind: "forged" as "projection" },
    }, projectionInput),
    ["AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC"],
  );
});

test("policy plugin executes in a separate permission-restricted process", async () => {
  const normalized = normalizePolicyPlugin(plugin("complete-path.mjs", "projection"), "projection");
  const result = await executePolicyPlugin(normalized, projectionInput);
  assert.deepEqual(result, {
    selectedNodes: [],
    appendContent: {
      version: "offline-model-input/v1",
      history: [],
      candidateInput: { text: "input" },
      environment: { version: 1 },
    },
  });
});

test("policy plugin must return a synchronous canonical proposal", async () => {
  const normalized = normalizePolicyPlugin(plugin("async-policy.mjs", "projection"), "projection");
  await expectSandboxCode(
    () => executePolicyPlugin(normalized, projectionInput),
    ["AXIOMATIC_POLICY_SANDBOX_PLUGIN_ERROR"],
  );
});

test("policy plugin cannot import filesystem modules or use network fetch", async () => {
  const importPlugin = normalizePolicyPlugin(plugin("import-fs.mjs", "projection"), "projection");
  await expectSandboxCode(
    () => executePolicyPlugin(importPlugin, projectionInput),
    ["AXIOMATIC_POLICY_SANDBOX_PLUGIN_ERROR", "AXIOMATIC_POLICY_SANDBOX_PERMISSION"],
  );

  const fetchPlugin = normalizePolicyPlugin(plugin("fetch-network.mjs", "projection"), "projection");
  await expectSandboxCode(
    () => executePolicyPlugin(fetchPlugin, projectionInput),
    ["AXIOMATIC_POLICY_SANDBOX_PLUGIN_ERROR", "AXIOMATIC_POLICY_SANDBOX_PERMISSION"],
  );
});

test("policy plugin timeout and AbortSignal terminate the child process", async () => {
  const busy = normalizePolicyPlugin(
    plugin("busy.mjs", "projection", { timeoutMs: 100 }),
    "projection",
  );
  await expectSandboxCode(
    () => executePolicyPlugin(busy, projectionInput),
    ["AXIOMATIC_POLICY_SANDBOX_TIMEOUT"],
  );

  const controller = new AbortController();
  const promise = executePolicyPlugin(
    normalizePolicyPlugin(plugin("busy.mjs", "projection", { timeoutMs: 5_000 }), "projection"),
    projectionInput,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  await expectSandboxCode(
    () => promise,
    ["AXIOMATIC_POLICY_SANDBOX_ABORTED"],
  );
});

test("plugin result is still validated by the semantic host", async () => {
  const normalized = normalizePolicyPlugin(plugin("complete-path.mjs", "projection"), "projection");
  const result = await executePolicyPlugin(normalized, projectionInput);
  assert.equal("kind" in result, false);
  assert.equal("selectedNodes" in result, true);
});
