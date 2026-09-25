"""Test helpers use the REAL genesis child and TCP. No invented human claims."""
import queue
import threading
import time

import pytest

from deductio.entry_client import submit
from deductio.ledger import Ledger
from deductio.runtime import Engine


def function(name="f", code="pass"):
    return {"kind": "function", "data": {"name": name, "runner": "python", "code": code}}


def output(**data):
    return {"kind": "output", "data": data}


def request(functions="SELECT id FROM entries WHERE kind='function' AND position IS NOT NULL",
            inputs="SELECT id FROM entries WHERE 0"):
    return {"kind": "request", "data": {"functions": functions, "inputs": inputs}}


PREFIX = "import sys,json,time,sqlite3\nx=json.load(sys.stdin)\n"


def code_frame(kind, data):
    import json
    return f"print({json.dumps({'kind': kind, 'data': data})!r},flush=True)\n"


def pump(engine):
    # Unit setup pumps only the ordinary pipe path, leaving business requests
    # pending for the specific scheduling/resolution assertion under test.
    for _ in range(64):
        try:
            engine._message(engine.messages.get_nowait())
        except queue.Empty:
            break
    engine._reap()


def external(engine, frames=None, *, close=False):
    result = queue.Queue()

    def send():
        try:
            result.put((True, submit(engine.ledger.path, frames, close=close)))
        except BaseException as exc:
            result.put((False, exc))

    thread = threading.Thread(target=send)
    thread.start()
    deadline = time.monotonic() + 15
    while thread.is_alive() and time.monotonic() < deadline:
        pump(engine)
        thread.join(timeout=.005)
    if thread.is_alive():
        raise AssertionError("entry client timed out")
    ok, value = result.get_nowait()
    if not ok:
        raise value
    return value


def spin(engine, predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        engine.tick()
        if predicate():
            return
        time.sleep(.005)
    raise AssertionError("runtime condition timed out")


def claim_for(ledger, request_ref):
    return next(r["id"] for r in ledger.rows("claim") if r["data"]["request"] == request_ref)


def end_for(ledger, claim):
    return next(r for r in ledger.rows("end") if r["claim_id"] == claim)


def business_outputs(ledger):
    return [r for r in ledger.rows("output") if not any(key.startswith('entry_') for key in r["data"])]


@pytest.fixture
def harness(tmp_path):
    with Ledger(tmp_path / "ledger.db", create=True) as ledger:
        engine = Engine(ledger)
        engine.start()
        try:
            yield ledger, engine
        finally:
            engine.close()
