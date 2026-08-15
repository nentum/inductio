import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AxiomaticDurableEngine } from "../../src/axiomatic-durable-engine.ts";
import { AxiomaticSqliteConnection } from "../../src/axiomatic-sqlite-connection.ts";

const worker = fileURLToPath(new URL("./axiomatic-durable-worker.ts", import.meta.url));
const cuts = ["partial-projection", "attempt", "emission", "outcome"] as const;
type Cut = (typeof cuts)[number];

async function waitForCut(child: ReturnType<typeof spawn>, cut: Cut): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("crash worker stdout is not piped");
  return await new Promise<string>((resolve, reject) => {
    let output = "";
    stdout.setEncoding("utf8");
    const onData = (chunk: string): void => {
      output += chunk;
      const marker = `cut:${cut}:`;
      const index = output.indexOf(marker);
      if (index >= 0) {
        stdout.off("data", onData);
        resolve(output.slice(index + marker.length).split("\n", 1)[0]!);
      }
    };
    stdout.on("data", onData);
    child.stderr?.setEncoding("utf8");
    child.on("error", reject);
    child.on("close", (code, signal) => {
      reject(new Error(`crash worker exited before cut: code=${code} signal=${signal}\n${output}`));
    });
  });
}

async function waitForClose(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

function killProcess(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) throw new Error("crash worker has no pid");
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (result.status !== 0 && child.exitCode === null) {
      throw new Error(`taskkill failed: ${result.stdout}\n${result.stderr}`);
    }
    return;
  }
  child.kill("SIGKILL");
}

async function initialize(path: string): Promise<string> {
  const connection = AxiomaticSqliteConnection.open(path);
  const engine = AxiomaticDurableEngine.open(connection, {
    rootPrompt: "durable crash",
    toolDefinitions: [],
  });
  const stateRef = engine.stateRef();
  engine.close();
  return stateRef;
}

for (const cut of cuts) {
  test(`v2 durable ${cut} cut recovers without redispatch`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `axiomatic-durable-${cut}-`));
    const path = join(directory, "runtime.db");
    try {
      const initialStateRef = await initialize(path);
      const child = spawn(process.execPath, [worker, path, cut], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const evaluation = await waitForCut(child, cut);
      killProcess(child);
      const termination = await waitForClose(child);
      assert.ok(
        termination.signal === "SIGKILL" || termination.code !== 0,
        `worker must be OS-terminated: ${JSON.stringify(termination)}`,
      );

      const connection = AxiomaticSqliteConnection.open(path);
      const engine = AxiomaticDurableEngine.open(connection);
      if (cut === "partial-projection") {
        assert.equal(engine.stateRef(), initialStateRef);
        assert.equal(engine.state().ledger.roots.length, 1);
        assert.equal(engine.state().ledger.evaluations.length, 0);
        assert.equal(connection.get<{ count: number }>("SELECT COUNT(*) AS count FROM axiomatic_commands")!.count, 1);
      } else {
        const recovered = engine.evaluation(evaluation);
        if (cut === "outcome") {
          assert.equal(recovered.status, "completed");
          assert.equal(engine.state().ledger.emissions.length, 1);
          assert.equal(engine.state().ledger.outcomes.length, 1);
          assert.equal(engine.state().ledger.adoptions.length, 1);
          assert.equal(engine.state().ledger.nodes.length, 1);
        } else {
          assert.equal(recovered.status, "unknown");
          assert.equal(engine.state().ledger.outcomes.length, 0);
          assert.equal(engine.state().ledger.adoptions.length, 0);
          assert.equal(engine.state().ledger.nodes.length, 0);
          assert.equal(engine.state().ledger.evaluations[0]?.attempt?.ordinal, 0);
          if (cut === "emission") assert.equal(engine.state().ledger.emissions.length, 1);
          assert.throws(
            () => engine.claimAttempt(evaluation),
            (error: unknown) => error instanceof Error &&
              "code" in error && error.code === "AXIOMATIC_EVALUATION_NOT_DISPATCHABLE",
          );
        }
      }
      engine.close();
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
}
