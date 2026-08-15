import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AxiomaticDurableEngine } from "../../src/axiomatic-durable-engine.ts";
import { AxiomaticSqliteConnection } from "../../src/axiomatic-sqlite-connection.ts";

const worker = fileURLToPath(new URL("./axiomatic-durable-worker.ts", import.meta.url));

interface WorkerResult {
  readonly output: string;
  readonly status: number | null;
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("worker stdout is not piped");
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const onData = (chunk: string): void => {
      output += chunk;
      if (output.includes("ready\n")) {
        stdout.off("data", onData);
        resolve();
      }
    };
    stdout.setEncoding("utf8");
    stdout.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== null && !output.includes("ready\n")) reject(new Error(`worker exited before ready: ${code}`));
    });
  });
}

function finish(child: ReturnType<typeof spawn>): Promise<WorkerResult> {
  const stdout = child.stdout;
  if (!stdout) return Promise.reject(new Error("worker stdout is not piped"));
  return new Promise((resolve, reject) => {
    let output = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ output, status }));
  });
}

test("two durable writers race from one v2 command head and one loses with CAS conflict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "axiomatic-durable-race-"));
  const path = join(directory, "runtime.db");
  try {
    const connection = AxiomaticSqliteConnection.open(path);
    const engine = AxiomaticDurableEngine.open(connection, {
      rootPrompt: "race",
      toolDefinitions: [],
    });
    const initialStateRef = engine.stateRef();
    engine.close();

    const first = spawn(process.execPath, [worker, path], { stdio: ["pipe", "pipe", "pipe"] });
    const second = spawn(process.execPath, [worker, path], { stdio: ["pipe", "pipe", "pipe"] });
    await Promise.all([waitForReady(first), waitForReady(second)]);
    const firstResult = finish(first);
    const secondResult = finish(second);
    first.stdin.end("go\n");
    second.stdin.end("go\n");
    const results = await Promise.all([firstResult, secondResult]);
    const success = results.filter((result) => result.output.includes("ok\n"));
    const conflicts = results.filter((result) => result.output.includes("err:AXIOMATIC_SQLITE_CONFLICT\n"));
    assert.equal(success.length, 1, results.map((result) => result.output).join(" | "));
    assert.equal(conflicts.length, 1, results.map((result) => result.output).join(" | "));

    const reopened = AxiomaticDurableEngine.open(AxiomaticSqliteConnection.open(path));
    assert.notEqual(reopened.stateRef(), initialStateRef);
    assert.equal(reopened.state().ledger.invocationOccurrences.length, 1);
    assert.equal(reopened.state().ledger.evaluationOccurrences.length, 1);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
