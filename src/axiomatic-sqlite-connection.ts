import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";

import { SemanticError, STORAGE_CODES } from "./errors.ts";
import {
  AXIOMATIC_APPLICATION_ID,
  AXIOMATIC_SCHEMA_NAME,
  AXIOMATIC_SCHEMA_VERSION,
  AXIOMATIC_THREAT_BOUNDARY,
  AXIOMATIC_USER_VERSION,
  axiomaticSchemaHash,
  readAxiomaticSchemaDdl,
} from "./axiomatic-sqlite-schema.ts";

const MIN_NODE = [22, 23, 0] as const;
const MIN_SQLITE = [3, 51, 3] as const;

interface DriverError extends Error {
  readonly errcode?: number;
  readonly errstr?: string;
}

export interface AxiomaticSqliteOpenOptions {
  readonly busyTimeoutMs?: number;
}

function fail(code: string, message: string): never {
  throw new SemanticError(code, message);
}

function parseVersion(value: string): readonly [number, number, number] {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) fail(STORAGE_CODES.SCHEMA_MISMATCH, `无法解析运行时版本 ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function translate(error: unknown): never {
  if (error instanceof SemanticError) throw error;
  const driver = error as DriverError;
  const text = `${driver.errstr ?? ""} ${driver.message ?? ""}`.toLowerCase();
  if (driver.errcode === 5 || driver.errcode === 6 || text.includes("busy") || text.includes("locked")) {
    fail(STORAGE_CODES.BUSY, "axiomatic SQLite 存储正忙");
  }
  if (driver.errcode === 11 || driver.errcode === 26 || text.includes("corrupt") || text.includes("not a database")) {
    fail(STORAGE_CODES.CORRUPT, "axiomatic SQLite 完整性检查失败");
  }
  fail(STORAGE_CODES.CORRUPT, "axiomatic SQLite 操作失败");
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
}

function schemaObjects(): readonly { readonly type: string; readonly name: string; readonly sql: string }[] {
  const ddl = readAxiomaticSchemaDdl();
  const result: { type: string; name: string; sql: string }[] = [];
  for (const match of ddl.matchAll(/CREATE TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+\(([\s\S]*?)\)\s+STRICT\s*;/g)) {
    result.push({ type: "table", name: match[1]!, sql: normalizeSql(match[0]!) });
  }
  for (const match of ddl.matchAll(/CREATE TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]*?)END\s*;/g)) {
    result.push({ type: "trigger", name: match[1]!, sql: normalizeSql(match[0]!) });
  }
  for (const match of ddl.matchAll(/CREATE (?:UNIQUE\s+)?INDEX\s+([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]*?);/g)) {
    result.push({ type: "index", name: match[1]!, sql: normalizeSql(match[0]!) });
  }
  for (const match of ddl.matchAll(/CREATE VIEW\s+([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]*?);/g)) {
    result.push({ type: "view", name: match[1]!, sql: normalizeSql(match[0]!) });
  }
  return result.toSorted((left, right) => `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`));
}

export class AxiomaticSqliteConnection {
  readonly path: string;
  readonly #database: DatabaseSync;
  #closed = false;
  #inTransaction = false;
  #savepoint = 0;

  private constructor(path: string, database: DatabaseSync) {
    this.path = path;
    this.#database = database;
  }

  static open(path: string, options: AxiomaticSqliteOpenOptions = {}): AxiomaticSqliteConnection {
    const node = parseVersion(process.versions.node);
    const sqlite = parseVersion(process.versions.sqlite ?? "");
    if (!atLeast(node, MIN_NODE) || !atLeast(sqlite, MIN_SQLITE)) {
      fail(STORAGE_CODES.SCHEMA_MISMATCH, `未验证的 Node/SQLite 组合：${process.versions.node}/${process.versions.sqlite}`);
    }
    if (!path || path === ":memory:" || !isAbsolute(path) || /^\\\\|^\/\//.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path.replace(/^[A-Za-z]:[\\/]/, ""))) {
      fail(STORAGE_CODES.UNSUPPORTED_FILESYSTEM, "axiomatic SQLite 只接受本地绝对文件路径");
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      fail("INVALID_STORAGE_OPTION", "busyTimeoutMs 必须是非负安全整数");
    }
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(path, {
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
      });
    } catch (error) {
      translate(error);
    }
    const connection = new AxiomaticSqliteConnection(path, database);
    try {
      connection.#configure(busyTimeoutMs);
      connection.#installOrVerifySchema();
      connection.#verifyHealth();
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  get inTransaction(): boolean {
    return this.#inTransaction;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#database.close();
    } catch (error) {
      translate(error);
    }
  }

  get<T>(sql: string, ...params: readonly unknown[]): T | undefined {
    this.#assertOpen();
    try {
      return this.#database.prepare(sql).get(...(params as never[])) as T | undefined;
    } catch (error) {
      translate(error);
    }
  }

  all<T>(sql: string, ...params: readonly unknown[]): T[] {
    this.#assertOpen();
    try {
      return this.#database.prepare(sql).all(...(params as never[])) as T[];
    } catch (error) {
      translate(error);
    }
  }

  getBigInt<T = Record<string, unknown>>(sql: string, ...params: readonly unknown[]): T | undefined {
    this.#assertOpen();
    try {
      const statement = this.#database.prepare(sql);
      statement.setReadBigInts(true);
      return statement.get(...(params as never[])) as T | undefined;
    } catch (error) {
      translate(error);
    }
  }

  allBigInt<T = Record<string, unknown>>(sql: string, ...params: readonly unknown[]): T[] {
    this.#assertOpen();
    try {
      const statement = this.#database.prepare(sql);
      statement.setReadBigInts(true);
      return statement.all(...(params as never[])) as T[];
    } catch (error) {
      translate(error);
    }
  }

  run(sql: string, ...params: readonly unknown[]): void {
    this.#assertOpen();
    try {
      this.#database.prepare(sql).run(...(params as never[]));
    } catch (error) {
      translate(error);
    }
  }

  withSavepoint<T>(fn: () => T): T {
    this.#assertOpen();
    if (!this.#inTransaction) fail(STORAGE_CODES.CORRUPT, "savepoint 必须位于事务内");
    const name = `axiomatic_sp_${++this.#savepoint}`;
    this.#exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.#exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      try {
        this.#exec(`ROLLBACK TO ${name}`);
        this.#exec(`RELEASE ${name}`);
      } catch {
        // Preserve the original semantic/storage error.
      }
      throw error;
    }
  }

  withReadTransaction<T>(fn: () => T): T {
    return this.#withTransaction("BEGIN", fn);
  }

  withImmediateTransaction<T>(fn: () => T): T {
    return this.#withTransaction("BEGIN IMMEDIATE", fn);
  }

  #withTransaction<T>(begin: "BEGIN" | "BEGIN IMMEDIATE", fn: () => T): T {
    this.#assertOpen();
    if (this.#inTransaction) return fn();
    this.#exec(begin);
    this.#inTransaction = true;
    try {
      const result = fn();
      this.#commit();
      return result;
    } catch (error) {
      if (error instanceof SemanticError && error.code === STORAGE_CODES.COMMIT_UNKNOWN) {
        this.#poison();
        throw error;
      }
      try {
        this.#exec("ROLLBACK");
        this.#inTransaction = false;
      } catch {
        this.#poison();
        fail(STORAGE_CODES.COMMIT_UNKNOWN, "axiomatic SQLite 事务回滚结果未知，连接已关闭");
      }
      if (error instanceof SemanticError) throw error;
      translate(error);
    }
  }

  #configure(busyTimeoutMs: number): void {
    this.#exec("PRAGMA foreign_keys = ON");
    this.#exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    this.#exec("PRAGMA journal_mode = WAL");
    this.#exec("PRAGMA synchronous = FULL");
    this.#exec("PRAGMA trusted_schema = OFF");
    if (this.pragma("foreign_keys") !== 1 || this.pragma("journal_mode") !== "wal" || this.pragma("synchronous") !== 2 || this.pragma("busy_timeout") !== busyTimeoutMs || this.pragma("trusted_schema") !== 0) {
      fail(STORAGE_CODES.CORRUPT, "axiomatic SQLite PRAGMA 未按要求生效");
    }
  }

  #installOrVerifySchema(): void {
    const tables = this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    if (tables.length === 0) {
      this.withImmediateTransaction(() => {
        const current = this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
        if (current.length !== 0) return;
        this.#exec(readAxiomaticSchemaDdl());
        this.run(
          `INSERT INTO axiomatic_schema_manifest(singleton, schema_name, schema_version, schema_hash, threat_boundary)
           VALUES (1, ?, ?, ?, ?)`,
          AXIOMATIC_SCHEMA_NAME,
          AXIOMATIC_SCHEMA_VERSION,
          axiomaticSchemaHash(),
          AXIOMATIC_THREAT_BOUNDARY,
        );
        this.#exec(`PRAGMA application_id = ${AXIOMATIC_APPLICATION_ID}`);
        this.#exec(`PRAGMA user_version = ${AXIOMATIC_USER_VERSION}`);
      });
    }
    this.#verifyHeader();
    const manifest = this.get<{ schema_name: string; schema_version: number; schema_hash: string; threat_boundary: string }>(
      "SELECT schema_name, schema_version, schema_hash, threat_boundary FROM axiomatic_schema_manifest WHERE singleton = 1",
    );
    if (!manifest || manifest.schema_name !== AXIOMATIC_SCHEMA_NAME || manifest.schema_version !== AXIOMATIC_SCHEMA_VERSION || manifest.schema_hash !== axiomaticSchemaHash() || manifest.threat_boundary !== AXIOMATIC_THREAT_BOUNDARY) {
      fail(STORAGE_CODES.SCHEMA_MISMATCH, "axiomatic schema manifest 不匹配");
    }
    const expectedObjects = schemaObjects();
    const actual = this.all<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'trigger', 'index', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
    if (actual.length !== expectedObjects.length) fail(STORAGE_CODES.SCHEMA_MISMATCH, "axiomatic schema object 集合不匹配");
    for (let index = 0; index < actual.length; index += 1) {
      const left = actual[index]!;
      const right = expectedObjects[index]!;
      if (left.type !== right.type || left.name !== right.name || normalizeSql(left.sql) !== right.sql) {
        fail(STORAGE_CODES.SCHEMA_MISMATCH, `axiomatic schema object ${left.name} 不匹配`);
      }
    }
  }

  #verifyHeader(): void {
    if (this.pragma("application_id") !== AXIOMATIC_APPLICATION_ID || this.pragma("user_version") !== AXIOMATIC_USER_VERSION) {
      fail(STORAGE_CODES.SCHEMA_MISMATCH, "axiomatic SQLite header 不匹配");
    }
  }

  #verifyHealth(): void {
    this.#verifyHeader();
    const integrity = this.all<Record<string, unknown>>("PRAGMA integrity_check");
    if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") fail(STORAGE_CODES.CORRUPT, "axiomatic SQLite integrity_check 未通过");
    if (this.all<Record<string, unknown>>("PRAGMA foreign_key_check").length !== 0) fail(STORAGE_CODES.CORRUPT, "axiomatic SQLite foreign_key_check 未通过");
  }

  pragma(name: string): unknown {
    this.#assertOpen();
    const row = this.get<Record<string, unknown>>(`PRAGMA ${name}`);
    if (!row) return undefined;
    const values = Object.values(row);
    return values.length === 1 ? values[0] : row;
  }

  #commit(): void {
    try {
      this.#database.exec("COMMIT");
      this.#inTransaction = false;
    } catch (error) {
      if (this.#database.isTransaction) {
        let rolledBack = false;
        try {
          this.#database.exec("ROLLBACK");
          rolledBack = true;
          this.#inTransaction = false;
        } catch {
          // Fall through: durable outcome is unknown.
        }
        if (rolledBack) translate(error);
      }
      this.#poison();
      fail(STORAGE_CODES.COMMIT_UNKNOWN, "axiomatic SQLite COMMIT 结果未知，连接已关闭");
    }
  }

  #poison(): void {
    this.#inTransaction = false;
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#database.close();
    } catch {
      // The connection is intentionally unusable.
    }
  }

  #exec(sql: string): void {
    this.#assertOpen();
    try {
      this.#database.exec(sql);
    } catch (error) {
      translate(error);
    }
  }

  #assertOpen(): void {
    if (this.#closed) fail(STORAGE_CODES.CLOSED, "axiomatic SQLite 连接已关闭");
  }
}

export function axiomaticSqliteExists(path: string): boolean {
  return existsSync(path);
}
