"""Launch and exercise an isolated local service through its public HTTP API."""

import json
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
TERMINAL = {"succeeded", "failed", "timeout", "cancelled"}


def until(check, timeout=10):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        last = check()
        if last:
            return last
        time.sleep(0.035)
    raise AssertionError(f"condition not met within {timeout}s; last observation={last!r}")


class LocalService:
    def __init__(self, directory, projects=None):
        self.directory = Path(directory)
        self.data = self.directory / "data"
        self.projects = projects or ROOT / "projects"
        self.process = None

    def start(self):
        path = self.directory / "server.log"
        with path.open("ab") as log:
            offset = log.tell()
            self.process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "task_service",
                    "--port",
                    "0",
                    "--data-dir",
                    str(self.data),
                    "--projects",
                    str(self.projects),
                ],
                cwd=ROOT,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )

        def address():
            with path.open("rb") as log:
                log.seek(offset)
                lines = log.read().decode(errors="replace")
            if self.process.poll() is not None:
                raise RuntimeError(lines)
            match = re.search(r"Uvicorn running on (http://127\.0\.0\.1:\d+)", lines)
            return match and match.group(1)

        self.url = until(address)

    def stop(self, sig=signal.SIGTERM):
        if self.process and self.process.poll() is None:
            self.process.send_signal(sig)
            self.process.wait(timeout=12)

    def request(self, path, method="GET", body=None, media="application/json"):
        data = json.dumps(body).encode() if body is not None and not isinstance(body, bytes) else body
        req = Request(self.url + path, data=data, method=method, headers={"Content-Type": media})
        try:
            resp = urlopen(req, timeout=4)
        except HTTPError as exc:
            resp = exc
        with resp:
            payload = resp.read()
            if resp.headers.get_content_type() == "application/json":
                payload = json.loads(payload)
            return resp.status, payload

    def submit(self, project="hello", kind="test", timeout=30):
        status, result = self.request(
            "/tasks", "POST", {"project_id": project, "type": kind, "timeout_seconds": timeout}
        )
        if status != 202:
            raise AssertionError(result)
        return "/tasks/" + result["id"]

    def get(self, path):
        status, result = self.request(path)
        if status != 200:
            raise AssertionError(result)
        return result

    def finished(self, path):
        def check():
            row = self.get(path)
            return row if row["status"] in TERMINAL else None

        try:
            return until(check)
        except AssertionError as exc:
            raise AssertionError((self.get(path), self.get(path + "/logs"))) from exc
