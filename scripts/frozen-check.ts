import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const FROZEN_FILES = {
  "LICENSE": "27dc6c11acc1b90f54b814d0737bc85c69df3bfeeae2425460eb47ed6dfb526c",
  "schema/003-axiomatic-v2.sql":
    "8dc3198d15e117a940fa5fe5e1bbe223a5877af43a87e50771a0264098ac7ed4",
  "test/vectors/axiomatic-public-v1.json":
    "29e450f59d5a043e4b7f97c1809ca1e03c1a72a0f78b6834793aea6590cea9d4",
} as const;

const REQUIRED_FILES = [
  "README.md",
  "RELEASE-SCOPE.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/INDUCTIO-0.4.0-RELEASE-CHECKPOINT.zh-CN.md",
] as const;

const EXPECTED_SOURCE_FILES = [
  "axiomatic-durable-engine.ts",
  "axiomatic-sqlite-connection.ts",
  "axiomatic-sqlite-schema.ts",
  "axiomatic-v2.ts",
  "canonical-v1.ts",
  "errors.ts",
  "in-memory-agent-runtime.ts",
  "index.ts",
  "model-adapter.ts",
  "model-adapters.ts",
  "model-contract.ts",
  "policy-sandbox.ts",
  "sqlite-agent-runtime.ts",
  "types.ts",
] as const;

const IMPORT_PATTERN = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseVersion(value: string): readonly [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value);
  assert(match, `cannot parse version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

function sourceFiles(): readonly string[] {
  return readdirSync(join(root, "src"))
    .filter((name) => statSync(join(root, "src", name)).isFile())
    .toSorted();
}

function resolveLocal(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = join(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next supported TypeScript resolution shape.
    }
  }
  return undefined;
}

function checkProductionGraph(): void {
  const queue = [join(root, "src/index.ts")];
  const seen = new Set<string>();
  const expected = new Set(EXPECTED_SOURCE_FILES.map((name) => `src/${name}`));
  while (queue.length > 0) {
    const file = queue.pop()!;
    const name = relative(root, file).split(sep).join("/");
    if (seen.has(name)) continue;
    assert(expected.has(name), `public entry reaches unexpected source module: ${name}`);
    seen.add(name);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1]!;
      assert(!specifier.includes("/test/") && !specifier.includes("../test"),
        `${name} imports test code: ${specifier}`);
      if (specifier === "node:sqlite") {
        assert(name === "src/axiomatic-sqlite-connection.ts",
          `${name} imports node:sqlite outside the private connection boundary`);
      }
      const resolved = resolveLocal(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }
  for (const name of expected) {
    assert(seen.has(name), `source module is orphaned from the public production graph: ${name}`);
  }
}

function checkMetadata(): void {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly packages?: Record<string, Record<string, unknown>>;
  };
  assert(manifest.name === "inductio", "package name must be inductio");
  assert(manifest.version === "0.4.0", "package version must be 0.4.0");
  assert(manifest.license === "MIT", "package license must be MIT");
  assert(manifest.private === false, "package must explicitly allow publication");
  assert(manifest.packageManager === "npm@10.9.8", "release npm version must be pinned");
  assert(lock.name === manifest.name && lock.version === manifest.version,
    "package lock root identity does not match package.json");
  assert(
    lock.packages?.[""]?.name === manifest.name &&
      lock.packages?.[""]?.version === manifest.version,
    "package lock workspace identity does not match package.json",
  );
  assert(lock.packages?.[""]?.license === "MIT", "package lock license must be MIT");
  assert(manifest.dependencies === undefined && manifest.optionalDependencies === undefined &&
    manifest.peerDependencies === undefined, "runtime dependency fields must remain absent");

  const repository = manifest.repository as Record<string, unknown> | undefined;
  assert(repository?.url === "git+https://github.com/nentum/inductio.git",
    "repository metadata does not point to the Inductio repository");
  const files = manifest.files;
  assert(Array.isArray(files) && files.includes("LICENSE"), "npm artifact must include LICENSE");
}

for (const [name, expected] of Object.entries(FROZEN_FILES)) {
  const actual = sha256(join(root, name));
  assert(actual === expected, `frozen file changed: ${name}\nexpected ${expected}\nactual   ${actual}`);
}
for (const name of REQUIRED_FILES) {
  assert(statSync(join(root, name)).isFile(), `missing required project file: ${name}`);
}
assert(
  JSON.stringify(sourceFiles()) === JSON.stringify([...EXPECTED_SOURCE_FILES].toSorted()),
  `source module set changed without updating the project contract:\n${sourceFiles().join("\n")}`,
);
assert(atLeast(parseVersion(process.versions.node), [22, 23, 0]),
  `Node.js >=22.23.0 is required; current ${process.versions.node}`);
assert(atLeast(parseVersion(process.versions.sqlite ?? ""), [3, 51, 3]),
  `SQLite >=3.51.3 is required; current ${process.versions.sqlite ?? "unknown"}`);

checkProductionGraph();
checkMetadata();

const brandedFiles = [
  "src/model-adapter.ts",
  "src/policy-sandbox.ts",
  ".github/workflows/release-check.yml",
  "package.json",
  "RELEASE-SCOPE.md",
];
for (const name of brandedFiles) {
  const source = readFileSync(join(root, name), "utf8");
  assert(!source.includes("axiomatic-agent-runtime"), `${name} contains the old package name`);
  assert(!source.includes("agent-runtime-policy-sandbox"), `${name} contains the old sandbox name`);
}

const workflow = readFileSync(join(root, ".github/workflows/release-check.yml"), "utf8");
assert(!workflow.includes("inductio-0.3.0.tgz"), "workflow still uploads the 0.3.0 artifact");
assert(workflow.includes("inductio-0.4.0.tgz"), "workflow does not upload the 0.4.0 artifact");

console.log("INDUCTIO_FROZEN_CHECK=PASS");
