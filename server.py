#!/usr/bin/env python3
"""Serves the lid angle dashboard and streams live readings over SSE.

A single background thread owns the `lidangle --watch` subprocess and publishes the
latest reading; every connected browser reads that shared value, so opening several
tabs never opens several sensor handles.
"""

import http.server
import json
import os
import socketserver
import subprocess
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
READER = os.path.join(HERE, "lidangle")
PORT = int(os.environ.get("LIDANGLE_PORT", "8787"))

_state = {"angle": None, "t": 0.0, "error": None}
_lock = threading.Lock()


def reader_loop():
    """Keep `lidangle --watch` alive, republishing whatever it prints."""
    while True:
        try:
            proc = subprocess.Popen(
                [READER, "--watch"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
            )
            for line in proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                with _lock:
                    _state.update(angle=msg["angle"], t=msg["t"], error=None)
            err = (proc.stderr.read() or "").strip()
            with _lock:
                _state["error"] = err or "sensor reader exited"
        except OSError as exc:
            with _lock:
                _state["error"] = str(exc)
        time.sleep(2)  # sensor vanished (sleep/wake); back off and retry


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def do_GET(self):
        if self.path.startswith("/stream"):
            return self.stream()
        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last = None
        try:
            while True:
                with _lock:
                    payload = dict(_state)
                # Resend unchanged values about twice a second so the page can tell
                # "the lid is still" apart from "the stream died".
                changed = payload != last
                if changed or time.time() - (last or {}).get("_sent", 0) > 0.5:
                    payload["_sent"] = time.time()
                    self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
                    self.wfile.flush()
                    last = payload
                time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    threading.Thread(target=reader_loop, daemon=True).start()
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Lid angle dashboard -> http://127.0.0.1:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")
