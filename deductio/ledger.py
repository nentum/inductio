"""Append-only state. The connection and writer lock belong to ONE thread.

Triggers defend against accidental misuse, not an adversary with file access.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import time
import uuid

from . import PROTOCOL, __version__
from .locking import WriterLock

MAX_FRAME = 1_048_576
MAX_QUERY_ROWS = 10_000
QUERY_STEPS = 200_000
QUERY_SECONDS = 0.2
SCHEMA_VERSION = 2


class InvalidEntry(ValueError):
    pass


class Sealed(InvalidEntry):
    pass


def json_text(value):
    try:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(text.encode("utf-8")) > MAX_FRAME:
            raise InvalidEntry("JSON exceeds 1 MiB")
        return text
    except (ValueError, TypeError, RecursionError, UnicodeError) as exc:
        raise InvalidEntry(str(exc)) from exc


def parse_json(text):
    def reject(value):
        raise InvalidEntry(f"non-JSON number: {value}")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise InvalidEntry(f"duplicate JSON key: {key}")
            result[key] = value
        return result

    try:
        return json.loads(text, parse_constant=reject, object_pairs_hook=unique)
    except (ValueError, RecursionError) as exc:
        raise InvalidEntry(str(exc)) from exc


def entry_dict(row):
    result = dict(row)
    result["data"] = json.loads(result["data"])
    return result


SCHEMA = """
CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('function','request','claim','output','end','event')),
    data TEXT NOT NULL CHECK(json_valid(data)),
    claim_id INTEGER REFERENCES entries(id),
    position INTEGER,
    writer TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK(position IS NULL OR (claim_id IS NOT NULL AND position > 0
          AND kind IN ('function','request','output')))
);
CREATE INDEX by_kind ON entries(kind, id);
CREATE INDEX by_claim ON entries(claim_id, id);
CREATE UNIQUE INDEX output_position ON entries(claim_id,position) WHERE position IS NOT NULL;
CREATE UNIQUE INDEX one_end ON entries(claim_id) WHERE kind='end';
CREATE UNIQUE INDEX one_resolution ON entries(json_extract(data,'$.request'))
    WHERE kind='event' AND json_extract(data,'$.event')='resolution';
CREATE UNIQUE INDEX one_claim_per_match ON entries(
    json_extract(data,'$.request'),json_extract(data,'$.function'))
    WHERE kind='claim' AND json_extract(data,'$.request') IS NOT NULL;
CREATE TRIGGER no_update BEFORE UPDATE ON entries BEGIN
    SELECT RAISE(ABORT,'append-only: UPDATE forbidden');
END;
CREATE TRIGGER no_delete BEFORE DELETE ON entries BEGIN
    SELECT RAISE(ABORT,'append-only: DELETE forbidden');
END;
CREATE TRIGGER no_output_after_end BEFORE INSERT ON entries
WHEN NEW.position IS NOT NULL AND EXISTS(
    SELECT 1 FROM entries WHERE kind='end' AND claim_id=NEW.claim_id)
BEGIN SELECT RAISE(ABORT,'instance sealed'); END;
CREATE TRIGGER valid_claim_reference BEFORE INSERT ON entries
WHEN NEW.claim_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM entries WHERE id=NEW.claim_id AND kind='claim')
BEGIN SELECT RAISE(ABORT,'invalid claim reference'); END;
PRAGMA user_version=2;
"""


class Ledger:
    def __init__(self, path, *, create=False):
        self.path = Path(path).resolve()
        self.writer = uuid.uuid4().hex
        self.lock = WriterLock(self.path)
        self.conn = None
        if create:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        elif not self.path.is_file():
            raise InvalidEntry("ledger does not exist; use init first")
        # Version-check existing files read-only BEFORE any writable open.
        if self.path.exists() and self.path.stat().st_size > 0:
            check = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)
            try:
                version = check.execute("PRAGMA user_version").fetchone()[0]
                if version != SCHEMA_VERSION:
                    raise InvalidEntry(f"schema {version} is read-only in this version; create a NEW schema 2 ledger")
            finally:
                check.close()
        self.lock.acquire()
        try:
            existed = self.path.exists() and self.path.stat().st_size > 0
            self.conn = sqlite3.connect(self.path, isolation_level=None, timeout=2)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA foreign_keys=ON")
            self.conn.execute("PRAGMA synchronous=FULL")
            self.conn.execute("PRAGMA recursive_triggers=ON")
            version = self.conn.execute("PRAGMA user_version").fetchone()[0]
            if not existed and create:
                self.conn.execute("PRAGMA journal_mode=WAL")
                self.conn.executescript("BEGIN IMMEDIATE;\n" + SCHEMA)
                seed = Path(__file__).with_name("entry_seed.py").read_text(encoding="utf-8-sig")
                self._append("event", {"event": "genesis", "schema": SCHEMA_VERSION,
                                       "protocol": PROTOCOL, "version": __version__,
                                       "ledger_id": uuid.uuid4().hex, "entry_function": 2})
                entry = self._append("function", {"name": "human", "runner": "python", "code": seed})
                if entry != 2:
                    raise InvalidEntry("invalid genesis entry reference")
                self._append("function", {"name": "stop", "runner": "builtin:stop"})
                self.conn.execute("COMMIT")
            elif version != SCHEMA_VERSION:
                raise InvalidEntry(f"unsupported ledger schema: {version}")
        except BaseException:
            self.close()
            raise

    def close(self):
        try:
            if self.conn is not None:
                self.conn.close()
                self.conn = None
        finally:
            self.lock.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    @contextmanager
    def transaction(self):
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.conn.execute("COMMIT")
        except BaseException:
            if self.conn.in_transaction:
                self.conn.execute("ROLLBACK")
            raise

    def _append(self, kind, data, claim_id=None, position=None):
        cursor = self.conn.execute(
            "INSERT INTO entries(kind,data,claim_id,position,writer,created_at) VALUES(?,?,?,?,?,?)",
            (kind, json_text(data), claim_id, position, self.writer,
             datetime.now(timezone.utc).isoformat()),
        )
        return cursor.lastrowid

    def get(self, ref):
        if type(ref) is not int or not 0 < ref <= 2**63 - 1:
            raise InvalidEntry("reference must be a positive signed 64-bit integer")
        row = self.conn.execute("SELECT * FROM entries WHERE id=?", (ref,)).fetchone()
        if row is None:
            raise InvalidEntry(f"unknown entry: {ref}")
        return entry_dict(row)

    def rows(self, kind=None):
        if kind is None:
            cursor = self.conn.execute("SELECT * FROM entries ORDER BY id")
        else:
            cursor = self.conn.execute("SELECT * FROM entries WHERE kind=? ORDER BY id", (kind,))
        return [entry_dict(row) for row in cursor]

    def event(self, name, data=None, claim_id=None):
        return self._append("event", {**(data or {}), "event": name}, claim_id)

    def builtin(self, runner):
        row = self.conn.execute(
            "SELECT id FROM entries WHERE kind='function' AND position IS NULL "
            "AND json_extract(data,'$.runner')=? ORDER BY id LIMIT 1", (runner,),
        ).fetchone()
        if row is None:
            raise InvalidEntry(f"missing builtin: {runner}")
        return row[0]

    @staticmethod
    def validate_frame(frame):
        if not isinstance(frame, dict) or set(frame) != {"kind", "data"}:
            raise InvalidEntry('output requires exactly {"kind":...,"data":...}')
        kind, data = frame["kind"], frame["data"]
        if kind not in ("function", "request", "output") or not isinstance(data, dict):
            raise InvalidEntry("only function/request/output objects can be emitted")
        json_text(frame)
        if kind == "function":
            if data.get("runner") != "python" or not isinstance(data.get("code"), str):
                raise InvalidEntry("v1 user functions require runner=python and code text")
        if kind == "request":
            if not all(isinstance(data.get(key), str) and data[key].strip()
                       for key in ("functions", "inputs")):
                raise InvalidEntry("request requires functions and inputs SQL strings")

    def is_sealed(self, claim):
        return self.conn.execute(
            "SELECT id FROM entries WHERE kind='end' AND claim_id=?", (claim,),
        ).fetchone() is not None

    def accept_output(self, claim, frame):
        self.validate_frame(frame)
        if self.get(claim)["kind"] != "claim":
            raise InvalidEntry("output source must be a claim")
        if self.is_sealed(claim):
            raise Sealed(f"instance {claim} is sealed")
        position = self.conn.execute(
            "SELECT coalesce(max(position),0)+1 FROM entries WHERE claim_id=?", (claim,),
        ).fetchone()[0]
        return self._append(frame["kind"], frame["data"], claim, position)

    def seal(self, claim, *, reason, cause=None, evidence=None):
        if self.get(claim)["kind"] != "claim":
            raise InvalidEntry("end must target a claim")
        existing = self.conn.execute(
            "SELECT id FROM entries WHERE kind='end' AND claim_id=?", (claim,),
        ).fetchone()
        if existing:
            return existing[0], False
        last = self.conn.execute(
            "SELECT coalesce(max(position),0) FROM entries WHERE claim_id=?", (claim,),
        ).fetchone()[0]
        ref = self._append("end", {"reason": reason, "cause": cause,
                                  "last_position": last, "evidence": evidence or {}}, claim)
        return ref, True

    def entry_function(self):
        row = self.conn.execute(
            "SELECT data FROM entries WHERE kind='event' AND json_extract(data,'$.event')='genesis' ORDER BY id LIMIT 1"
        ).fetchone()
        if not row:
            raise InvalidEntry("missing genesis")
        ref = json.loads(row[0])["entry_function"]
        if self.get(ref)["kind"] != "function":
            raise InvalidEntry("genesis entry is not a function")
        return ref

    def startup_request(self):
        # Explicit host root, not an invented function output. Same ordinary
        # request evaluator below; eligibility is scoped to the owning session.
        return self._append("request", {
            "functions": f"SELECT id FROM entries WHERE id={self.entry_function()}",
            "inputs": "SELECT id FROM entries WHERE 0", "host_role": "startup",
            "session": self.writer,
        })

    def abandon_old_startups(self):
        requests = self.conn.execute("""
            SELECT id,writer FROM entries WHERE kind='request' AND position IS NULL
            AND json_extract(data,'$.host_role')='startup' AND writer<>? ORDER BY id
        """, (self.writer,)).fetchall()
        abandoned = []
        with self.transaction():
            for row in requests:
                if not self._resolved(row[0]):
                    abandoned.append(self.event("startup_abandoned", {
                        "request": row[0], "owner": row[1], "reason": "previous_session_not_replayed",
                    }))
        return abandoned

    def _resolved(self, request):
        return self.conn.execute("""
            SELECT id FROM entries WHERE
            (kind='event' AND json_extract(data,'$.event') IN ('resolution','startup_abandoned')
             AND json_extract(data,'$.request')=?) OR
            (kind='claim' AND json_extract(data,'$.request')=?) LIMIT 1
        """, (request, request)).fetchone() is not None

    def pending_requests(self, limit=64):
        rows = self.conn.execute("""
            SELECT r.id FROM entries r WHERE r.kind='request'
            AND (r.position IS NOT NULL OR coalesce(json_extract(r.data,'$.host_role'),'')<>'startup' OR r.writer=?)
            AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.kind='event'
              AND json_extract(e.data,'$.event') IN ('resolution','startup_abandoned')
              AND json_extract(e.data,'$.request')=r.id)
            AND NOT EXISTS (SELECT 1 FROM entries c WHERE c.kind='claim'
              AND json_extract(c.data,'$.request')=r.id)
            ORDER BY r.id LIMIT ?
        """, (self.writer, limit)).fetchall()
        return [row[0] for row in rows]

    def _query_ids(self, sql):
        if len(sql.encode("utf-8")) > 65536:
            raise InvalidEntry("query exceeds 64 KiB")
        deadline = time.monotonic() + QUERY_SECONDS
        steps = 0

        def progress():
            nonlocal steps
            steps += 1000
            return int(steps > QUERY_STEPS or time.monotonic() > deadline)

        def authorize(action, arg1, arg2, database, trigger):
            if action == sqlite3.SQLITE_READ:
                allowed = arg1 == "entries" and (database == "main" or (database is None and arg2 == ""))
                return sqlite3.SQLITE_OK if allowed else sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_FUNCTION:
                return sqlite3.SQLITE_DENY if (arg2 or "").lower() == "load_extension" else sqlite3.SQLITE_OK
            return (sqlite3.SQLITE_OK if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_RECURSIVE)
                    else sqlite3.SQLITE_DENY)

        old_length = self.conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_FRAME * 2)
        self.conn.set_authorizer(authorize)
        self.conn.set_progress_handler(progress, 1000)
        try:
            cursor = self.conn.execute(sql)
            if cursor.description is None or len(cursor.description) != 1 or cursor.description[0][0] != "id":
                raise InvalidEntry("query must return exactly one column named id")
            rows = cursor.fetchmany(MAX_QUERY_ROWS + 1)
            if len(rows) > MAX_QUERY_ROWS:
                raise InvalidEntry("query exceeds 10000 rows")
            if any(type(row[0]) is not int for row in rows):
                raise InvalidEntry("query id values must be integers")
            return sorted({row[0] for row in rows})
        finally:
            self.conn.set_authorizer(None)
            self.conn.set_progress_handler(None, 0)
            self.conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, old_length)

    def _intersection(self, refs, *, functions):
        if not refs:
            return []
        criterion = "kind='function'" if functions else "position IS NOT NULL"
        placeholders = ",".join("?" for _ in refs)
        return [row[0] for row in self.conn.execute(
            f"SELECT id FROM entries WHERE id IN ({placeholders}) AND {criterion} ORDER BY id", refs)]

    def resolve(self, request):
        """Evaluate once against one snapshot; commit the full selection and all
        claims before any process starts. Empty/invalid selections are consumed.
        """
        with self.transaction():
            if self._resolved(request):
                return []
            item = self.get(request)
            if item["kind"] != "request":
                raise InvalidEntry("resolution requires a request")
            if (item["position"] is None and item["data"].get("host_role") == "startup"
                    and item["writer"] != self.writer):
                self.event("startup_abandoned", {"request": request, "owner": item["writer"],
                           "reason": "previous_session_not_replayed"})
                return []
            snapshot = self.conn.execute("SELECT max(id) FROM entries").fetchone()[0]
            error = None
            functions, inputs = [], []
            try:
                functions = self._intersection(self._query_ids(item["data"]["functions"]), functions=True)
                inputs = self._intersection(self._query_ids(item["data"]["inputs"]), functions=False)
            except (sqlite3.Error, InvalidEntry) as exc:
                error = str(exc)
                functions, inputs = [], []
            resolution = self.event("resolution", {"request": request, "snapshot": snapshot,
                "functions": functions, "inputs": inputs, "error": error})
            claims = [self._append("claim", {"request": request, "resolution": resolution,
                      "function": function, "inputs": inputs, "snapshot": snapshot,
                      "session": self.writer}) for function in functions]
        return claims

    def recover(self):
        """No inferred success/failure or automatic re-execution after owner loss."""
        rows = self.conn.execute("""
            SELECT c.id FROM entries c WHERE c.kind='claim' AND NOT EXISTS(
              SELECT 1 FROM entries e WHERE e.kind='end' AND e.claim_id=c.id)
            ORDER BY c.id
        """).fetchall()
        with self.transaction():
            ends = [self.seal(row[0], reason="recovery_unknown", evidence={
                "process_state": "unobserved", "business_result": "unknown",
                "policy": "close_old_channel_without_reexecution",
            })[0] for row in rows]
        return ends


def inspect_ledger(path, *, after=0, limit=1000):
    path = Path(path).resolve()
    if not path.is_file():
        raise InvalidEntry("ledger does not exist")
    conn = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return [entry_dict(row) for row in conn.execute(
            "SELECT * FROM entries WHERE id>? ORDER BY id LIMIT ?", (after, limit))]
    finally:
        conn.close()
