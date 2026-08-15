import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const AXIOMATIC_APPLICATION_ID = 0x41585632;
export const AXIOMATIC_USER_VERSION = 1;
export const AXIOMATIC_SCHEMA_NAME = "axiomatic-agent-sqlite/v2";
export const AXIOMATIC_SCHEMA_VERSION = 1;
export const AXIOMATIC_THREAT_BOUNDARY =
  "append-only semantic journal; internal consistency is not protection against wholesale rollback";

const schemaPath = fileURLToPath(new URL("../schema/003-axiomatic-v2.sql", import.meta.url));

export function readAxiomaticSchemaDdl(): string {
  return readFileSync(schemaPath, "utf8");
}

export function axiomaticSchemaHash(): string {
  return `sha256:${createHash("sha256").update(readAxiomaticSchemaDdl(), "utf8").digest("hex")}`;
}

export function axiomaticSchemaDdlPath(): string {
  return join(schemaPath);
}
