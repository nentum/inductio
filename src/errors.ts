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
  COMMIT_UNKNOWN: "STORAGE_COMMIT_UNKNOWN",
} as const;
