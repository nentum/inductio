"""A real CLI/entry-client demo; no direct ledger write shortcuts."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from .entry_client import probe, submit
from .ledger import InvalidEntry, Ledger, inspect_ledger


def run_demo(path):
    path = Path(path).resolve()
    if path.exists():
        raise InvalidEntry("demo needs a new path; existing ledgers are never overwritten")
    with Ledger(path, create=True):
        pass
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    root = Path(__file__).resolve().parent.parent
    process = subprocess.Popen([sys.executable, "-m", "deductio", "run", str(path), "--until-idle"],
        cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", **kwargs)
    logs, errors = [], []
    threads = [threading.Thread(target=lambda: logs.extend(process.stdout)),
               threading.Thread(target=lambda: errors.extend(process.stderr))]
    for thread in threads:
        thread.start()
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            info = probe(path)
            if info["state"] == "reachable":
                break
            if process.poll() is not None:
                raise RuntimeError("interpreter exited before entry became available")
            time.sleep(.03)
        else:
            raise RuntimeError("entry did not become available")
        examples = root / "examples"
        refs = submit(path, [
            {"kind": "function", "data": {"name": "demo.echo", "runner": "python",
                "code": (examples / "echo.py").read_text(encoding="utf-8-sig")}},
            {"kind": "function", "data": {"name": "demo.parent", "runner": "python",
                "code": (examples / "parent.py").read_text(encoding="utf-8-sig")}},
        ])["entries"]
        request = submit(path, [{"kind": "request", "data": {
            "functions": f"SELECT id FROM entries WHERE id={refs[1]}",
            "inputs": "SELECT id FROM entries WHERE 0",
        }}])["entries"][0]
        submit(path, close=True)
        process.wait(timeout=15)
        if process.returncode:
            raise RuntimeError("interpreter failed: " + "".join(errors))
        rows = inspect_ledger(path)
        claims = [row for row in rows if row["kind"] == "claim"]
        parent = next(row for row in claims if row["data"]["request"] == request)
        child = next(row for row in claims if row["data"]["function"] == refs[0])
        ends = {row["claim_id"]: row for row in rows if row["kind"] == "end"}
        received = next(row for row in rows if row["kind"] == "output"
                        and row["data"].get("tag") == "demo.parent_received")
        assert child["id"] < received["id"] < ends[parent["id"]]["id"]
        assert all(ends[row["id"]]["data"]["reason"] == "function_end" for row in (parent, child))
        assert all(next(row for row in rows if row["id"] == ref)["claim_id"] == info["claim"] for ref in refs)
        return {"database": str(path), "entry_claim": info["claim"], "parent_claim": parent["id"],
                "child_claim": child["id"], "parent_received": received["id"],
                "parent_end": ends[parent["id"]]["id"],
                "verified": "real_external_entry_and_child_ran_while_parent_open"}
    finally:
        if process.poll() is None:
            try:
                process.stdin.write('{"op":"shutdown"}\n')
                process.stdin.flush()
                process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
                process.wait(timeout=5)
        process.stdin.close()
        for thread in threads:
            thread.join(timeout=2)
        process.stdout.close()
        process.stderr.close()
