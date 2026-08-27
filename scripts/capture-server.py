#!/usr/bin/env python3
"""Capture endpoint for the screenshot harness.

The application asks for a screenshot and blocks on the response, so the reply
is only sent once the image is safely on disk. That handshake is what keeps the
capture in step with the interface without any guessing at timings.
"""

import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import unquote, urlparse

OUT = os.environ["CAPTURE_OUT"]
TITLE = os.environ.get("CAPTURE_TITLE", "GoTek Manager")
PORT = int(os.environ.get("CAPTURE_PORT", "8791"))


def find_window() -> str:
    """Returns the X window id of the application's main window."""
    tree = subprocess.run(
        ["xwininfo", "-root", "-tree"], capture_output=True, text=True, check=True
    ).stdout
    for line in tree.splitlines():
        # Skip the tiny decoration and icon windows the toolkit also creates.
        if f'"{TITLE}"' in line and "1x1" not in line:
            return line.split()[0]
    raise RuntimeError(f"No window titled {TITLE!r} is on the display yet")


class Handler(BaseHTTPRequestHandler):
    def _reply(self, status: int, body: str = "ok") -> None:
        payload = body.encode()
        self.send_response(status)
        # The webview is a different origin from this server.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        url = urlparse(self.path)
        if url.path.startswith("/capture/"):
            name = os.path.basename(unquote(url.path))
            try:
                window = find_window()
                target = os.path.join(OUT, f"{name}.png")
                subprocess.run(
                    ["import", "-window", window, target], check=True, capture_output=True
                )
                print(f"captured {name}", flush=True)
                self._reply(200)
            except Exception as error:  # noqa: BLE001 - reported to the caller
                print(f"capture of {name} failed: {error}", file=sys.stderr, flush=True)
                self._reply(500, str(error))
            return

        if url.path == "/done":
            open(os.path.join(OUT, ".done"), "w").close()
            self._reply(200)
            return

        if url.path == "/failed":
            with open(os.path.join(OUT, ".failed"), "w") as handle:
                handle.write(unquote(url.query.removeprefix("reason=")))
            self._reply(200)
            return

        self._reply(404, "not found")

    def log_message(self, *_args) -> None:
        """Silences the default per-request logging."""


if __name__ == "__main__":
    print(f"capture server listening on 127.0.0.1:{PORT} -> {OUT}", flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
