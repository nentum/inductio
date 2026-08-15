import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AxiomaticDurableEngine } from "../../src/axiomatic-durable-engine.ts";
import { AxiomaticSqliteConnection } from "../../src/axiomatic-sqlite-connection.ts";
import { SemanticError } from "../../src/errors.ts";

const ROOT = { rootPrompt: "durable commands", toolDefinitions: [] } as const;
const ENDPOINT = {
  version: "opencode-go-endpoint/v1",
  provider: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1/",
  model: "deepseek-v4-flash",
} as const;

async function withPath<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "axiomatic-durable-engine-"));
  try {
    return await fn(join(directory, "runtime.db"));
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

function prepare(engine: AxiomaticDurableEngine, position: number) {
  return engine.prepareOpenCodeEvaluation({
    parent: engine.root().root,
    source: "durable-engine-test",
    position,
    input: [{ kind: "message", role: "user", content: `hello-${position}` }],
    environment: { version: "environment-snapshot/v1", values: null },
    endpoint: ENDPOINT,
  });
}

test("durable command replay preserves request-before-attempt and Emission-before-Outcome", async () => {
  await withPath((path) => {
    let connection = AxiomaticSqliteConnection.open(path);
    let engine = AxiomaticDurableEngine.open(connection, ROOT);
    const prepared = prepare(engine, 1);
    const requestSeq = connection.getBigInt<{ seq: bigint }>(
      "SELECT seq FROM axiomatic_commands WHERE command_kind = 'record-request'",
    )!.seq;
    engine.claimAttempt(prepared.evaluation);
    const attemptSeq = connection.getBigInt<{ seq: bigint }>(
      "SELECT seq FROM axiomatic_commands WHERE command_kind = 'claim-attempt'",
    )!.seq;
    assert.ok(requestSeq < attemptSeq);
    const output = [{ kind: "message" as const, role: "assistant" as const, content: "world" }];
    engine.recordEmission({
      evaluation: prepared.evaluation,
      ordinal: 0,
      producer: "test-provider",
      protocol: "test/v1",
      payload: output,
    });
    const emissionSeq = connection.getBigInt<{ seq: bigint }>(
      "SELECT seq FROM axiomatic_commands WHERE command_kind = 'record-emission'",
    )!.seq;
    engine.complete(prepared.evaluation, "completed", { finishReason: "stop" });
    const outcomeSeq = connection.getBigInt<{ seq: bigint }>(
      "SELECT seq FROM axiomatic_commands WHERE command_kind = 'complete-evaluation'",
    )!.seq;
    assert.ok(emissionSeq < outcomeSeq);
    const adoption = engine.adoptCompleted(
      prepared.evaluation,
      prepared.request.modelInput.candidateInput,
      output,
    );
    assert.ok(adoption.node);
    const stateRef = engine.stateRef();
    const nodeRef = adoption.node!.ref;
    engine.close();

    connection = AxiomaticSqliteConnection.open(path);
    engine = AxiomaticDurableEngine.open(connection);
    assert.equal(engine.stateRef(), stateRef);
    assert.equal(engine.evaluation(prepared.evaluation).status, "completed");
    assert.ok(engine.state().ledger.nodes.some((node) => node.ref === nodeRef));
    engine.close();
  });
});

test("restart converts an unclosed durable attempt to unknown and never grants a second attempt", async () => {
  await withPath((path) => {
    let connection = AxiomaticSqliteConnection.open(path);
    let engine = AxiomaticDurableEngine.open(connection, ROOT);
    const prepared = prepare(engine, 1);
    engine.claimAttempt(prepared.evaluation);
    assert.equal(engine.evaluation(prepared.evaluation).status, "attempted");
    engine.close();

    connection = AxiomaticSqliteConnection.open(path);
    engine = AxiomaticDurableEngine.open(connection);
    assert.equal(engine.evaluation(prepared.evaluation).status, "unknown");
    assert.throws(
      () => engine.claimAttempt(prepared.evaluation),
      (error: unknown) => error instanceof SemanticError &&
        error.code === "AXIOMATIC_EVALUATION_NOT_DISPATCHABLE",
    );
    const attempts = connection.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM axiomatic_execution_records WHERE record_kind = 'attempt'",
    )!.count;
    assert.equal(attempts, 1);
    engine.close();
  });
});

test("durable command head CAS rejects a stale concurrent writer", async () => {
  await withPath((path) => {
    const firstConnection = AxiomaticSqliteConnection.open(path);
    const first = AxiomaticDurableEngine.open(firstConnection, ROOT);
    const secondConnection = AxiomaticSqliteConnection.open(path);
    const second = AxiomaticDurableEngine.open(secondConnection);

    prepare(first, 1);
    assert.throws(
      () => prepare(second, 2),
      (error: unknown) => error instanceof SemanticError &&
        error.code === "AXIOMATIC_SQLITE_CONFLICT",
    );
    first.close();
    second.close();
  });
});

test("schema manifest and command-head guards reject mutation and unexpected objects", async () => {
  await withPath((path) => {
    const connection = AxiomaticSqliteConnection.open(path);
    const engine = AxiomaticDurableEngine.open(connection, ROOT);
    assert.throws(
      () => connection.run("UPDATE axiomatic_schema_manifest SET schema_version = schema_version + 1"),
      (error: unknown) => error instanceof SemanticError && error.code === "STORAGE_CORRUPT",
    );
    assert.throws(
      () => connection.run("UPDATE axiomatic_command_head SET command_seq = command_seq + 2"),
      (error: unknown) => error instanceof SemanticError && error.code === "STORAGE_CORRUPT",
    );
    connection.run("CREATE INDEX unexpected_axiomatic_index ON axiomatic_roots(agent_ref)");
    engine.close();
    assert.throws(
      () => AxiomaticSqliteConnection.open(path),
      (error: unknown) => error instanceof SemanticError && error.code === "SCHEMA_MISMATCH",
    );
  });
});
