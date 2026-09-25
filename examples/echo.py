"""Example ordinary function. Diagnostics go to stderr, JSON frames to stdout."""
import json
import sqlite3
import sys

call = json.load(sys.stdin)
connection = sqlite3.connect(call["ledger_uri"], uri=True)
for ref in call["inputs"]:
    data = json.loads(connection.execute("SELECT data FROM entries WHERE id=?", (ref,)).fetchone()[0])
    print(json.dumps({"kind": "output", "data": {
        "tag": "demo.reply", "parent": data["parent"], "echo": data["text"],
    }}), flush=True)
connection.close()
print(json.dumps({"kind": "end", "data": {"reason": "reply_submitted"}}), flush=True)
