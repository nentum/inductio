"""Publish work, dispatch another function, wait while this instance stays alive."""
import json
import sqlite3
import sys
import time

call = json.load(sys.stdin)
claim = call["claim"]


def emit(kind, data):
    print(json.dumps({"kind": kind, "data": data}), flush=True)


emit("output", {"tag": "demo.work", "parent": claim, "text": "你好，账本"})
emit("request", {
    "functions": "SELECT id FROM entries WHERE kind='function' AND json_extract(data,'$.name')='demo.echo'",
    "inputs": f"SELECT id FROM entries WHERE claim_id={claim} AND json_extract(data,'$.tag')='demo.work'",
})
connection = sqlite3.connect(call["ledger_uri"], uri=True)
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    reply = connection.execute(
        "SELECT id FROM entries WHERE kind='output' AND json_extract(data,'$.tag')='demo.reply' "
        "AND json_extract(data,'$.parent')=? ORDER BY id LIMIT 1", (claim,),
    ).fetchone()
    if reply:
        emit("output", {"tag": "demo.parent_received", "reply": reply[0]})
        emit("end", {"reason": "demonstration_complete"})
        break
    time.sleep(0.02)
else:
    raise RuntimeError("demonstration did not receive child output")
connection.close()
