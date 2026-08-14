export class SemanticError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SemanticError";
    this.code = code;
  }
}

export const STORAGE_CODES = {
  BUSY: "STORAGE_BUSY",
  CORRUPT: "STORAGE_CORRUPT",
  SCHEMA_MISMATCH: "SCHEMA_MISMATCH",
  UNSUPPORTED_FILESYSTEM: "UNSUPPORTED_FILESYSTEM",
  CLOSED: "STORAGE_CLOSED",
  LEASE_CLOCK_EXHAUSTED: "LEASE_CLOCK_EXHAUSTED",
  COMMIT_UNKNOWN: "STORAGE_COMMIT_UNKNOWN",
} as const;

/** 外层 IMMEDIATE 事务提交 clock / 过期观察后再抛出语义错误。 */
export class CommitAndThrow extends Error {
  readonly semantic: SemanticError;

  constructor(semantic: SemanticError) {
    super(semantic.message);
    this.name = "CommitAndThrow";
    this.semantic = semantic;
  }
}
