"""Genesis entry program: a REAL ordinary function, copied into new ledgers.

All external framing/validation below runs in the child, not in the interpreter.
No imports from the host package; it is executable directly from ledger source.
"""
import json
import os
import socket
import sqlite3
import sys
import time

MAX_FRAME = 1_048_576
call = json.load(sys.stdin)
claim = call["claim"]
connection = sqlite3.connect(call["ledger_uri"], uri=True, isolation_level=None)
claim_record = json.loads(connection.execute("SELECT data FROM entries WHERE id=?", (claim,)).fetchone()[0])
session = claim_record["session"]
ledger_id = json.loads(connection.execute(
    "SELECT data FROM entries WHERE kind='event' AND json_extract(data,'$.event')='genesis' ORDER BY id LIMIT 1"
).fetchone()[0])["ledger_id"]
position = 0


def decode(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def nonnumber(value):
        raise ValueError("non-JSON number")

    return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique, parse_constant=nonnumber)


def frame_text(frame):
    text = json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(text.encode("utf-8")) + 1 > MAX_FRAME:
        raise ValueError("output frame exceeds 1 MiB")
    return text


def validate(frame):
    if not isinstance(frame, dict) or set(frame) != {"kind", "data"}:
        raise ValueError("each entry requires exactly kind and data; source fields are forbidden")
    kind, data = frame["kind"], frame["data"]
    if kind not in ("function", "request", "output") or not isinstance(data, dict):
        raise ValueError("only function/request/output objects can be submitted")
    if kind == "function" and (data.get("runner") != "python" or not isinstance(data.get("code"), str)):
        raise ValueError("function requires runner=python and code text")
    if kind == "request" and not all(isinstance(data.get(key), str) and data[key].strip()
                                      for key in ("functions", "inputs")):
        raise ValueError("request requires functions and inputs SQL strings")
    return frame_text(frame)


def available():
    latest = connection.execute(
        "SELECT writer FROM entries WHERE kind='event' AND json_extract(data,'$.event')='session_started' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    sealed = connection.execute("SELECT 1 FROM entries WHERE kind='end' AND claim_id=?", (claim,)).fetchone()
    return latest is not None and latest[0] == session and sealed is None


def emit_many_and_confirm(frames):
    global position
    first = position + 1
    for frame in frames:
        print(frame_text(frame), flush=True)
        position += 1
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        rows = connection.execute(
            "SELECT id FROM entries WHERE claim_id=? AND position BETWEEN ? AND ? ORDER BY position",
            (claim, first, position),
        ).fetchall()
        if len(rows) == position - first + 1:
            return [row[0] for row in rows]
        if not available():
            raise RuntimeError("entry channel closed or superseded; outcome may be partial")
        time.sleep(.01)
    raise RuntimeError("ledger acknowledgement timed out; outcome unknown; do not blindly retry")


def emit_and_confirm(frame):
    return emit_many_and_confirm([frame])[0]


def send(client, value):
    client.sendall((json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))


def receive(client):
    buffer = bytearray()
    deadline = time.monotonic() + 10
    while b"\n" not in buffer:
        if time.monotonic() >= deadline:
            raise ValueError("input line deadline exceeded")
        part = client.recv(min(16384, MAX_FRAME + 1 - len(buffer)))
        if not part:
            raise ValueError("connection ended before newline")
        buffer.extend(part)
        if len(buffer) > MAX_FRAME:
            raise ValueError("external message exceeds 1 MiB")
    line, tail = bytes(buffer).split(b"\n", 1)
    if tail.strip():
        raise ValueError("one message per connection")
    return decode(line)


listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    # A new ephemeral endpoint per incarnation: never seize a previous PID/port.
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)
    listener.settimeout(.25)
    endpoint = {"protocol": "deductio.entry.v1", "host": "127.0.0.1", "port": listener.getsockname()[1],
                "ledger_id": ledger_id, "session": session, "claim": claim}
    # A normal output. Only the client understands this application-level tag.
    emit_and_confirm({"kind": "output", "data": {"entry_ready": endpoint, "pid": os.getpid()}})
    closing = False
    while not closing and available():
        try:
            client, _ = listener.accept()
        except socket.timeout:
            continue
        with client:
            client.settimeout(2)
            accepted_refs = []
            phase = "receiving"
            try:
                if not available():
                    break
                send(client, {"hello": endpoint})
                message = receive(client)
                if not isinstance(message, dict) or message.get("endpoint") != endpoint:
                    raise ValueError("wrong ledger/session/instance endpoint")
                operation = message.get("op")
                if operation == "ping" and set(message) == {"endpoint", "op"}:
                    # TCP liveness alone is insufficient: the old child could
                    # outlive a crashed interpreter. Confirm the complete path.
                    probe_ref = emit_and_confirm({"kind": "output", "data": {"entry_probe": True}})
                    send(client, {"pong": endpoint, "entry": probe_ref})
                elif operation == "close" and set(message) == {"endpoint", "op"}:
                    emit_and_confirm({"kind": "output", "data": {"entry_closing": True}})
                    print(frame_text({"kind": "end", "data": {"reason": "entry_client_closed"}}), flush=True)
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        row = connection.execute("SELECT id FROM entries WHERE kind='end' AND claim_id=?", (claim,)).fetchone()
                        if row:
                            try:
                                send(client, {"sealed": row[0], "claim": claim})
                            except OSError:
                                pass  # Seal is committed even if its receipt is lost.
                            closing = True
                            break
                        time.sleep(.01)
                    else:
                        raise RuntimeError("end acknowledgement timed out")
                elif operation == "append" and set(message) == {"endpoint", "op", "entries"}:
                    entries = message["entries"]
                    if not isinstance(entries, list) or not entries:
                        raise ValueError("entries must be a nonempty list")
                    for frame in entries:
                        validate(frame)
                    phase = "submitting"
                    accepted_refs = emit_many_and_confirm(entries)
                    phase = "replying"
                    send(client, {"claim": claim, "entries": accepted_refs})
                else:
                    raise ValueError("expected append, close or ping")
            except (ValueError, UnicodeError, RecursionError, OSError) as exc:
                # Message rejection is ordinary entry output, never a fabricated
                # human invocation or interpreter-side business parser.
                if available():
                    key = "entry_rejected" if phase == "receiving" else "entry_transport_error"
                    emit_and_confirm({"kind": "output", "data": {
                        key: str(exc)[:1000], "phase": phase, "accepted_entries": accepted_refs,
                    }})
                try:
                    send(client, {"error": str(exc)[:1000], "accepted_entries": accepted_refs})
                except OSError:
                    pass
            # A host acknowledgement failure is fatal: continuing could confuse
            # output positions or encourage unsafe retry of partially sent work.
finally:
    listener.close()
    connection.close()
