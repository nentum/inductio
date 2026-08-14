import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDtsBundle } from "dts-bundle-generator";
import { build } from "esbuild";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const dist = join(root, "dist");
const entry = join(root, "src/index.ts");

rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [entry],
  outfile: join(dist, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.23",
  packages: "bundle",
  treeShaking: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

const [declarations] = generateDtsBundle(
  [
    {
      filePath: entry,
      output: {
        noBanner: true,
        sortNodes: true,
        exportReferencedTypes: true,
      },
    },
  ],
  { preferredConfigPath: join(root, "tsconfig.build.json") },
);
if (!declarations) throw new Error("Declaration bundle was not generated");
writeFileSync(join(dist, "index.d.ts"), declarations, "utf8");

for (const path of [
  join(root, "package.json"),
  join(root, "README.md"),
  join(root, "RELEASE-SCOPE.md"),
  join(dist, "index.js"),
  join(dist, "index.d.ts"),
]) {
  chmodSync(path, 0o644);
}
