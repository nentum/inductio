"""CLI and JSON-lines control transport. stdout is machine-readable UTF-8."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading

from .ledger import InvalidEntry, Ledger, MAX_FRAME, inspect_ledger, parse_json
from .locking import WriterBusy
from .runtime import Engine
from .transport import FrameError, console_lines, lines


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False), flush=True)


def command_reader(engine, stream):
    source = (console_lines(engine.reader_stop, MAX_FRAME)
              if os.name == "nt" and stream.isatty()
              else lines(stream, engine.reader_stop, MAX_FRAME))
    try:
        for raw in source:
            try:
                value = parse_json(raw.decode("utf-8-sig"))
                engine.post(("command", None, value))
            except (InvalidEntry, UnicodeError) as exc:
                engine.post(("command_error", None, str(exc)))
    except (FrameError, OSError) as exc:
        engine.post(("command_error", None, str(exc)))
    # EOF closes only the input transport, not the scheduler.


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Deductio v1 append-only interpreter")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "append", "run", "show", "entry-status", "close-entry", "demo"):
        item = sub.add_parser(name)
        item.add_argument("database", type=Path)
        if name == "append":
            item.add_argument("file", help="JSON entry/list file, or - to read stdin")
        if name == "run":
            item.add_argument("--until-idle", action="store_true",
                              help="exit only after entry is closed AND all work drains; host stdin control remains active")
            item.add_argument("--max-running", type=int, default=8)
        if name == "show":
            item.add_argument("--after", type=int, default=0)
            item.add_argument("--limit", type=int, default=1000)
    args = parser.parse_args(argv)
    try:
        if args.command == "show":
            if args.after < 0 or not 1 <= args.limit <= 100_000:
                raise InvalidEntry("after >= 0 and 1 <= limit <= 100000 required")
            for row in inspect_ledger(args.database, after=args.after, limit=args.limit):
                emit(row)
        elif args.command == "init":
            with Ledger(args.database, create=True) as ledger:
                emit({"database": str(ledger.path), "schema": 2, "entry_function": ledger.entry_function(),
                      "stop": ledger.builtin("builtin:stop")})
        elif args.command == "append":
            from .entry_client import submit
            if args.file == "-":
                raw = sys.stdin.buffer.read(MAX_FRAME + 1)
            else:
                with Path(args.file).open("rb") as source:
                    raw = source.read(MAX_FRAME + 1)
            if len(raw) > MAX_FRAME:
                raise InvalidEntry("submission exceeds 1 MiB")
            # Thin transport client only: business validation is in entry code.
            value = parse_json(raw.decode("utf-8-sig"))
            emit(submit(args.database, value))
        elif args.command in ("entry-status", "close-entry"):
            from .entry_client import probe, submit
            emit(submit(args.database, close=True) if args.command == "close-entry" else probe(args.database))
        elif args.command == "run":
            if args.max_running < 1:
                raise InvalidEntry("max-running must be positive")
            with Ledger(args.database) as ledger:
                engine = Engine(ledger, max_running=args.max_running, notify=emit)
                reader = None
                try:
                    engine.start()
                    reader = threading.Thread(target=command_reader, args=(engine, sys.stdin.buffer))
                    reader.start()
                    engine.run(until_idle=args.until_idle)
                finally:
                    try:
                        engine.close()
                    finally:
                        engine.reader_stop.set()
                        if reader is not None:
                            reader.join(timeout=2)
                emit({"event": "stopped", "reason": engine.shutdown_reason})
        elif args.command == "demo":
            from .demo import run_demo
            emit(run_demo(args.database))
        return 0
    except (InvalidEntry, WriterBusy, OSError, UnicodeError, sqlite3.Error) as exc:
        print(f"error: {exc}", file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
