"""Single-threaded ledger scheduler; pipe readers never write to the ledger.

Only direct child processes are managed. Untrusted-code isolation and escaped
children are explicitly outside v1's guarantee.
"""
from collections import deque
from dataclasses import dataclass, field
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time

from . import PROTOCOL, __version__
from .ledger import InvalidEntry, MAX_FRAME, json_text, parse_json
from .transport import FrameError, chunks, lines


@dataclass
class Running:
    process: subprocess.Popen
    claim: int
    stdout_done: bool = False
    stderr_done: bool = False
    stopped_at: float | None = None
    exited_at: float | None = None
    last_message_at: float = field(default_factory=time.monotonic)
    stdout_finished: threading.Event = field(default_factory=threading.Event)
    stderr_finished: threading.Event = field(default_factory=threading.Event)
    exit_recorded: bool = False
    late_frames: int = 0
    threads: list = field(default_factory=list)
    cancel: threading.Event = field(default_factory=threading.Event)


class Engine:
    def __init__(self, ledger, *, max_running=8, notify=None):
        if max_running < 1:
            raise ValueError("max_running must be positive")
        self.ledger = ledger
        self.max_running = max_running
        self.notify = notify or (lambda message: None)
        self.messages = queue.Queue(maxsize=256)
        self.reader_stop = threading.Event()
        self.waiting = deque()
        self.running = {}
        self.temp = tempfile.TemporaryDirectory(prefix="deductio-v1-")
        self.shutdown_reason = None
        self.started = False
        self.closed = False
        self.entry_request = None
        self.entry_claim = None

    def start(self):
        if self.started:
            return
        self.ledger.event("session_started", {"version": __version__, "protocol": PROTOCOL,
                          "pid": os.getpid(), "max_running": self.max_running})
        recovered = self.ledger.recover()
        abandoned = self.ledger.abandon_old_startups()
        self.entry_request = self.ledger.startup_request()
        claims = self.ledger.resolve(self.entry_request)
        if len(claims) == 1:
            self.entry_claim = claims[0]
            # Reserved extra slot, always attempted BEFORE any ordinary backlog.
            self._spawn(self.entry_claim)
        else:
            self.ledger.event("entry_start_failed", {"request": self.entry_request,
                              "reason": "startup_did_not_select_one_function"})
        self.started = True
        self.notify({"event": "interpreter_started", "writer": self.ledger.writer,
                     "recovered": recovered, "abandoned": abandoned,
                     "entry_request": self.entry_request, "entry_claim": self.entry_claim,
                     "entry_available": "unconfirmed_use_entry_status"})

    def post(self, message):
        while not self.reader_stop.is_set():
            try:
                self.messages.put(message, timeout=0.1)
                return
            except queue.Full:
                pass

    def _stdout(self, run):
        try:
            for line in lines(run.process.stdout, run.cancel, MAX_FRAME):
                frame = parse_json(line.decode("utf-8"))
                self.post(("frame", run.claim, frame))
        except (InvalidEntry, UnicodeError, FrameError, OSError) as exc:
            self.post(("protocol_error", run.claim, str(exc)))
        finally:
            run.process.stdout.close()
            run.stdout_finished.set()
            self.post(("stdout_done", run.claim, None))

    def _stderr(self, run):
        captured = bytearray()
        total = 0
        try:
            for chunk in chunks(run.process.stderr, run.cancel, size=4096):
                total += len(chunk)
                captured.extend(chunk[:max(0, 16384 - len(captured))])
        except OSError:
            pass
        finally:
            run.process.stderr.close()
            run.stderr_finished.set()
            self.post(("stderr_done", run.claim, {"text": captured.decode("utf-8", errors="replace"),
                                                 "bytes": total, "truncated": total > len(captured)}))

    def _spawn(self, claim):
        item = self.ledger.get(claim)["data"]
        function = self.ledger.get(item["function"])["data"]
        script = Path(self.temp.name) / f"claim-{claim}.py"
        envelope = {
            "protocol": PROTOCOL, "function": item["function"], "claim": claim,
            "inputs": item["inputs"], "snapshot": item["snapshot"],
            "ledger_uri": self.ledger.path.as_uri() + "?mode=ro",
        }
        try:
            if function.get("runner") != "python":
                raise InvalidEntry("unsupported runner")
            script.write_text(function["code"], encoding="utf-8")
            wire_input = (json_text(envelope) + "\n").encode("utf-8")
            kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
            # stdin remains the same JSON + EOF protocol. A completed input
            # file eliminates a pipe-writer thread that a non-reading function
            # (or inherited pipe in its descendants) could keep blocked.
            input_path = Path(self.temp.name) / f"claim-{claim}.json"
            input_path.write_bytes(wire_input)
            with input_path.open("rb") as input_file:
                process = subprocess.Popen(
                    [sys.executable, "-I", "-u", "-X", "utf8", str(script)],
                    stdin=input_file, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    cwd=self.temp.name, **kwargs,
                )
        except (OSError, ValueError, InvalidEntry) as exc:
            self.ledger.event("spawn_failed", {"error": str(exc)}, claim)
            self.ledger.seal(claim, reason="spawn_failed", evidence={"error": str(exc)})
            return
        run = Running(process, claim)
        self.running[claim] = run
        # Store the object before any fallible DB write, so cleanup can kill it.
        self.ledger.event("process_started", {"pid": process.pid}, claim)
        for function, args in ((self._stdout, (run,)), (self._stderr, (run,))):
            thread = threading.Thread(target=function, args=args, daemon=True)
            thread.start()
            run.threads.append(thread)

    def _kill(self, run):
        if run.process.poll() is not None:
            return
        try:
            run.process.kill()
            self.ledger.event("termination_requested", {"pid": run.process.pid}, run.claim)
        except OSError as exc:
            self.ledger.event("termination_error", {"error": str(exc)}, run.claim)

    def _seal(self, claim, *, reason, cause=None, evidence=None, immediate=False):
        end, fresh = self.ledger.seal(claim, reason=reason, cause=cause, evidence=evidence)
        run = self.running.get(claim)
        if run:
            if fresh:
                run.stopped_at = time.monotonic()
            if immediate:
                self._kill(run)
        return end, fresh

    def _stop_builtin(self, claim):
        data = self.ledger.get(claim)["data"]
        try:
            if len(data["inputs"]) != 1:
                raise InvalidEntry("stop requires one input containing target and reason")
            note_ref = data["inputs"][0]
            note = self.ledger.get(note_ref)["data"]
            target, reason = note.get("target"), note.get("reason", "explicit_stop")
            if type(target) is not int or not isinstance(reason, str):
                raise InvalidEntry("stop target must be a claim reference and reason must be text")
            end, fresh = self._seal(target, reason="explicit_stop", cause=note_ref,
                evidence={"requested_reason": reason, "controller": claim}, immediate=True)
            if not self.ledger.is_sealed(claim):
                self.ledger.accept_output(claim, {"kind": "output", "data": {
                    "target": target, "end": end, "newly_sealed": fresh,
                    "meaning": "output_channel_closed_not_business_success",
                }})
                self._seal(claim, reason="builtin_returned")
        except InvalidEntry as exc:
            self.ledger.event("builtin_error", {"error": str(exc)}, claim)
            self._seal(claim, reason="builtin_error", evidence={"error": str(exc)})

    def _handle_frame(self, claim, frame):
        if self.ledger.is_sealed(claim):
            self.running[claim].late_frames += 1
            return
        if isinstance(frame, dict) and frame.get("kind") == "end":
            if set(frame) != {"kind", "data"} or not isinstance(frame["data"], dict):
                raise InvalidEntry("end requires kind and data object")
            json_text(frame)
            reason = frame["data"].get("reason", "function_returned")
            if not isinstance(reason, str):
                raise InvalidEntry("end reason must be text")
            cause = self.ledger.event("end_requested", {"declaration": frame["data"]}, claim)
            self._seal(claim, reason="function_end", cause=cause,
                       evidence={"declared_reason": reason})
        else:
            ref = self.ledger.accept_output(claim, frame)
            self.notify({"event": "accepted", "claim": claim, "entry": ref})

    def command(self, value):
        """External input is transported to the writer, never a second DB writer."""
        if self.shutdown_reason:
            raise InvalidEntry("interpreter is shutting down")
        if not isinstance(value, dict):
            raise InvalidEntry("command must be an object")
        op = value.get("op")
        if op == "stop" and set(value) <= {"op", "claim", "reason"}:
            target, reason = value.get("claim"), value.get("reason", "operator_requested")
            if self.ledger.get(target)["kind"] != "claim" or not isinstance(reason, str):
                raise InvalidEntry("stop requires an existing claim and text reason")
            cause = self.ledger.event("host_stop_requested", {"target": target, "reason": reason})
            end, fresh = self._seal(target, reason="explicit_stop", cause=cause,
                                   evidence={"requested_reason": reason}, immediate=True)
            return {"target": target, "end": end, "newly_sealed": fresh}
        if op == "shutdown" and set(value) <= {"op", "reason"}:
            self.shutdown(value.get("reason", "human_shutdown"))
            return {"shutdown_requested": True}
        raise InvalidEntry("host control accepts only stop/shutdown; send content to the real entry using append CLI")

    def _message(self, message):
        kind, claim, data = message
        if kind == "command":
            try:
                self.notify({"event": "command_result", "result": self.command(data)})
            except InvalidEntry as exc:
                ref = self.ledger.event("command_rejected", {"error": str(exc)})
                self.notify({"event": "command_error", "entry": ref, "error": str(exc)})
            return
        if kind == "command_error":
            ref = self.ledger.event("command_rejected", {"error": str(data)})
            self.notify({"event": "command_error", "entry": ref, "error": str(data)})
            return
        run = self.running.get(claim)
        if run is None:
            return
        run.last_message_at = time.monotonic()
        if kind == "frame":
            try:
                self._handle_frame(claim, data)
            except InvalidEntry as exc:
                self._message(("protocol_error", claim, str(exc)))
        elif kind == "protocol_error":
            if self.ledger.is_sealed(claim):
                run.late_frames += 1
            else:
                cause = self.ledger.event("protocol_error", {"error": data}, claim)
                self._seal(claim, reason="protocol_error", cause=cause, immediate=True)
        elif kind == "stdout_done":
            run.stdout_done = True
        elif kind == "stderr_done":
            run.stderr_done = True
            if data["bytes"]:
                # Diagnostics are interpreter observations, not function output.
                self.ledger.event("stderr", data, claim)

    def _reap(self):
        now = time.monotonic()
        for claim, run in list(self.running.items()):
            code = run.process.poll()
            if code is None:
                if run.stopped_at is not None and now - run.stopped_at > 0.2:
                    self._kill(run)
                continue
            if not run.exit_recorded:
                self.ledger.event("process_exited", {"pid": run.process.pid, "exit_code": code}, claim)
                run.exit_recorded = True
                run.exited_at = now
            if run.stdout_done:
                self._seal(claim, reason="process_exit", evidence={"exit_code": code})
            # An escaped descendant can keep inherited pipes open. We don't
            # pretend it stopped, or wait forever; close the protocol boundary.
            # A slow consumer must not mistake its own queued output for an
            # escaped pipe. Only apply the fallback after no processing progress,
            # and never cut off a reader whose EOF marker is already queued.
            readers_finished = run.stdout_finished.is_set() and run.stderr_finished.is_set()
            detached = (not readers_finished and
                        now - max(run.exited_at, run.last_message_at) > 2.0)
            if detached:
                self._seal(claim, reason="channel_unconfirmed", evidence={
                    "exit_code": code, "pipe_eof": run.stdout_done,
                    "note": "direct_child_exited_but_pipe_cleanup_incomplete",
                })
                self.ledger.event("pipe_cleanup_unconfirmed", {"pid": run.process.pid}, claim)
            if (run.stdout_done and run.stderr_done) or detached:
                run.cancel.set()
                self._close_readers(run)
                if run.late_frames:
                    self.ledger.event("late_output_rejected", {"frames": run.late_frames}, claim)
                del self.running[claim]

    @staticmethod
    def _close_readers(run):
        run.cancel.set()
        for thread in run.threads:
            thread.join(timeout=.5)
        # A failure after spawn can occur before either reader starts. Those
        # pipes then have no worker responsible for closing them.
        if len(run.threads) < 1:
            run.process.stdout.close()
        if len(run.threads) < 2:
            run.process.stderr.close()

    def tick(self):
        self.start()
        for _ in range(32):
            try:
                self._message(self.messages.get_nowait())
            except queue.Empty:
                break
        self._reap()
        if not self.shutdown_reason:
            # Bounded batches preserve fairness, not a wait-for-all barrier.
            for request in self.ledger.pending_requests(limit=16):
                for claim in self.ledger.resolve(request):
                    function = self.ledger.get(self.ledger.get(claim)["data"]["function"])["data"]
                    if function["runner"] == "builtin:stop":
                        self._stop_builtin(claim)
                    else:
                        self.waiting.append(claim)
            while self.waiting and sum(ref != self.entry_claim for ref in self.running) < self.max_running:
                claim = self.waiting.popleft()
                if not self.ledger.is_sealed(claim):
                    self._spawn(claim)
        return bool(self.running or self.waiting or not self.messages.empty()
                    or (not self.shutdown_reason and self.ledger.pending_requests(limit=1)))

    def run(self, *, until_idle=False, max_seconds=None):
        started = time.monotonic()
        try:
            while True:
                active = self.tick()
                if max_seconds is not None and time.monotonic() - started >= max_seconds:
                    self.shutdown("operator_deadline")
                if self.shutdown_reason and not self.running:
                    break
                if until_idle and not active:
                    break
                time.sleep(0.005)
        except KeyboardInterrupt:
            self.shutdown("keyboard_interrupt")
            while self.tick():
                time.sleep(0.005)
        finally:
            self.close()

    def shutdown(self, reason="operator_shutdown"):
        if self.shutdown_reason:
            return
        if not isinstance(reason, str) or not reason:
            raise InvalidEntry("shutdown reason must be nonempty text")
        self.shutdown_reason = reason
        cause = self.ledger.event("shutdown_requested", {"reason": reason})
        while self.waiting:
            claim = self.waiting.popleft()
            self._seal(claim, reason="interpreter_shutdown", cause=cause,
                       evidence={"process_state": "not_started"})
        for claim in list(self.running):
            self._seal(claim, reason="interpreter_shutdown", cause=cause, immediate=True)

    def close(self):
        if self.closed:
            return
        try:
            self.shutdown("engine_closed")
            deadline = time.monotonic() + 3
            while self.running and time.monotonic() < deadline:
                for _ in range(64):
                    try:
                        self._message(self.messages.get_nowait())
                    except queue.Empty:
                        break
                self._reap()
                time.sleep(0.005)
            for run in self.running.values():
                self._kill(run)
                try:
                    run.process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    self.ledger.event("cleanup_unconfirmed", {"pid": run.process.pid}, run.claim)
            self.ledger.event("session_stopped", {"reason": self.shutdown_reason})
        finally:
            self.reader_stop.set()
            # If storage failed, still make a best-effort direct-child cleanup.
            for run in self.running.values():
                run.cancel.set()
                if run.process.poll() is None:
                    try:
                        run.process.kill()
                        run.process.wait(timeout=1)
                    except (OSError, subprocess.TimeoutExpired):
                        pass
            for run in self.running.values():
                self._close_readers(run)
            try:
                self.temp.cleanup()
            finally:
                self.closed = True
