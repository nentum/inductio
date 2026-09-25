"""Read-only discovery + TCP client. Never opens a writable ledger connection."""
import json
from pathlib import Path
import socket
import sqlite3
import time

from .ledger import InvalidEntry, MAX_FRAME, parse_json


def status(path):
    path = Path(path).resolve()
    if not path.is_file():
        raise InvalidEntry("ledger does not exist")
    con = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        genesis = con.execute("SELECT data FROM entries WHERE kind='event' AND json_extract(data,'$.event')='genesis' ORDER BY id LIMIT 1").fetchone()
        data = json.loads(genesis[0]) if genesis else {}
        if data.get("schema") != 2:
            raise InvalidEntry("entry transport requires schema 2; old ledgers remain read-only")
        run = con.execute("SELECT id,writer FROM entries WHERE kind='event' AND json_extract(data,'$.event')='session_started' ORDER BY id DESC LIMIT 1").fetchone()
        if not run:
            return {"state": "not_running", "endpoint": None}
        session = run["writer"]
        stopped = con.execute("SELECT 1 FROM entries WHERE kind='event' AND writer=? AND json_extract(data,'$.event')='session_stopped'", (session,)).fetchone()
        boot = con.execute("SELECT id FROM entries WHERE kind='request' AND position IS NULL AND writer=? AND json_extract(data,'$.host_role')='startup' ORDER BY id DESC LIMIT 1", (session,)).fetchone()
        claim = None if not boot else con.execute("SELECT id FROM entries WHERE kind='claim' AND json_extract(data,'$.request')=? ORDER BY id LIMIT 1", (boot[0],)).fetchone()
        result = {"state": "session_stopped" if stopped else "starting", "session": session,
                  "request": boot[0] if boot else None, "claim": claim[0] if claim else None, "endpoint": None}
        if claim:
            end = con.execute("SELECT id,data FROM entries WHERE kind='end' AND claim_id=?", (claim[0],)).fetchone()
            if end:
                result.update(state="sealed", end=end[0], reason=json.loads(end[1])["reason"])
            elif not stopped:
                ready = con.execute("SELECT id,data FROM entries WHERE kind='output' AND claim_id=? AND json_type(data,'$.entry_ready')='object' ORDER BY position LIMIT 1", (claim[0],)).fetchone()
                if ready:
                    endpoint = json.loads(ready[1])["entry_ready"]
                    if (endpoint.get("ledger_id") == data["ledger_id"] and endpoint.get("session") == session
                            and endpoint.get("claim") == claim[0] and endpoint.get("host") == "127.0.0.1"
                            and type(endpoint.get("port")) is int and 0 < endpoint["port"] < 65536):
                        result.update(state="announced", endpoint=endpoint, ready_entry=ready[0])
        return result
    finally:
        con.close()


def read_line(client):
    data = bytearray()
    while b"\n" not in data:
        part = client.recv(min(16384, MAX_FRAME + 1 - len(data)))
        if not part:
            raise InvalidEntry("entry disconnected; if submitted, outcome unknown; inspect ledger before retry")
        data.extend(part)
        if len(data) > MAX_FRAME:
            raise InvalidEntry("entry response too large")
    return parse_json(bytes(data).split(b"\n", 1)[0].decode("utf-8"))


def connect(path, timeout=5):
    deadline = time.monotonic() + timeout
    while True:
        info = status(path)
        if info["state"] == "announced":
            break
        if info["state"] != "starting" or time.monotonic() >= deadline:
            raise InvalidEntry(f"entry unavailable: {info}; run the interpreter first")
        time.sleep(.02)
    endpoint = info["endpoint"]
    client = socket.create_connection((endpoint["host"], endpoint["port"]), timeout=2)
    try:
        client.settimeout(12)
        hello = read_line(client)
        if hello != {"hello": endpoint}:
            raise InvalidEntry("entry handshake identity mismatch; nothing sent")
        # Recheck before transmitting, so an old process cannot stand in for the
        # new session merely because its endpoint remains alive.
        if status(path).get("endpoint") != endpoint:
            raise InvalidEntry("entry changed during connection; nothing sent")
        return client, endpoint
    except BaseException:
        client.close()
        raise


def probe(path):
    info = status(path)
    if info["state"] != "announced":
        return info
    try:
        client, endpoint = connect(path)
        with client:
            client.sendall((json.dumps({"endpoint": endpoint, "op": "ping"}) + "\n").encode("utf-8"))
            reply = read_line(client)
            if reply.get("pong") != endpoint or type(reply.get("entry")) is not int:
                raise InvalidEntry("unexpected ping response")
        info.update(state="reachable", probe_entry=reply["entry"])
    except (OSError, InvalidEntry) as exc:
        info.update(state="unreachable", error=str(exc))
    return info


def submit(path, entries=None, *, close=False):
    client, endpoint = connect(path)
    with client:
        message = {"endpoint": endpoint, "op": "close" if close else "append"}
        if not close:
            message["entries"] = entries if isinstance(entries, list) else [entries]
        wire = (json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
        if len(wire) > MAX_FRAME:
            raise InvalidEntry("external message exceeds 1 MiB including envelope")
        try:
            client.sendall(wire)
            response = read_line(client)
        except OSError as exc:
            raise InvalidEntry("entry transport failed after sending began; outcome unknown; "
                               "inspect ledger before retry: " + str(exc)) from exc
        if not isinstance(response, dict):
            raise InvalidEntry("invalid entry response; inspect ledger before retry")
        if "error" in response:
            raise InvalidEntry(str(response["error"]) + "; accepted_entries=" + str(response.get("accepted_entries", [])))
        if response.get("claim") != endpoint["claim"]:
            raise InvalidEntry("receipt source mismatch; inspect ledger before retry")
        return response
