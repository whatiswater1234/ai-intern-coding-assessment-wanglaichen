import concurrent.futures
import io
import json
import os
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
import zipfile
from pathlib import Path

from scripts.local_service import ROOT, LocalService, until


def absent(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


class TaskServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.projects = self.folder / "projects"
        shutil.copytree(ROOT / "projects", self.projects)
        self.api = LocalService(self.folder, self.projects)
        self.addCleanup(self.api.stop)
        self.api.start()

    def fixture(self, name, module_body):
        tests = self.projects / name / "tests"
        tests.mkdir(parents=True)
        (tests / "__init__.py").touch()
        (tests / "test_job.py").write_text(textwrap.dedent(module_body))

    def reload(self):
        self.api.stop()
        self.api.start()

    def work(self, path):
        return self.api.data / "work" / path.rsplit("/", 1)[1]

    def ready(self, path):
        def read():
            text = self.api.get(path + "/logs")["text"]
            match = re.search(r"child_ready=(\d+)", text)
            return (int(re.search(r"leader=(\d+)", text)[1]), int(match[1])) if match else None

        return until(read)

    def database(self, query, params=()):
        with sqlite3.connect(self.api.data / "tasks.sqlite3") as db:
            return db.execute(query, params).fetchall()

    def test_success_failure_and_download(self):
        api = self.api
        for project, kind, state, rc in [
            ("hello", "lint", "succeeded", 0),
            ("hello", "test", "succeeded", 0),
            ("broken", "test", "failed", 1),
            ("hello", "build", "succeeded", 0),
        ]:
            path = api.submit(project, kind)
            row = api.finished(path)
            self.assertEqual((row["status"], row["exit_code"]), (state, rc), row)
            self.assertLessEqual(row["created_at"], row["started_at"])
            self.assertLessEqual(row["started_at"], row["finished_at"])
            self.assertFalse(self.work(path).exists())
            report = api.get(path + "/artifacts/result.json")
            for key in ("id", "status", "exit_code", "error"):
                self.assertEqual(row[key], report[key])
            if project == "broken":
                failed = path
                self.assertIn("20 != 21", api.get(path + "/logs")["text"])
            if kind == "build":
                listing = api.get(path + "/artifacts")["items"]
                archive = api.get(listing[0]["download_url"])
                self.assertEqual(listing[0]["size_bytes"], len(archive))
                target = self.folder / "download.pyz"
                target.write_bytes(archive)
                self.assertEqual(
                    subprocess.check_output([sys.executable, target], text=True), "Hello, Mac!\n"
                )
                self.assertEqual(api.request(failed + "/artifacts/app.pyz")[0], 404)
        self.assertFalse(any(self.projects.rglob("__pycache__")))

    def test_protocol_and_validation(self):
        api = self.api
        self.assertEqual(api.request("/docs")[0], 200)
        self.assertIn("/tasks/{task_id}/cancel", api.get("/openapi.json")["paths"])
        for body, code in [
            (b"{", 400),
            (b"a" * 8193, 413),
            ({}, 422),
            ({"project_id": "unknown", "type": "test"}, 422),
            ({"project_id": "hello", "type": "other"}, 422),
        ]:
            status, error = api.request("/tasks", "POST", body)
            self.assertEqual(status, code)
            self.assertIn("code", error["error"])
        for extra in [
            {"timeout_seconds": 0},
            {"timeout_seconds": 301},
            {"timeout_seconds": True},
            {"timeout_seconds": "2"},
            {"command": "echo test"},
        ]:
            self.assertEqual(
                api.request("/tasks", "POST", {"project_id": "hello", "type": "test", **extra})[0], 422
            )
        self.assertEqual(api.request("/tasks", "POST", b"{}", "text/plain")[0], 415)
        for suffix in ["", "/logs", "/artifacts", "/cancel", "/artifacts/result.json"]:
            method = "POST" if suffix == "/cancel" else "GET"
            self.assertEqual(api.request("/tasks/missing" + suffix, method)[0], 404)

    def test_parallel_queue_capacity_cancellation_and_isolation(self):
        api = self.api
        first, second = api.submit("slow"), api.submit("slow")
        groups = [self.ready(p) for p in (first, second)]
        for path in (first, second):
            (self.work(path) / "src" / "local.txt").write_text(path)
        self.assertEqual((self.work(first) / "src/local.txt").read_text(), first)
        self.assertFalse((self.projects / "slow/local.txt").exists())
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            queued = list(pool.map(lambda _: api.submit(), range(32)))
        self.assertEqual(api.request("/tasks", "POST", {"project_id": "hello", "type": "lint"})[0], 429)
        # Keep one waiting task. None of the others may ever acquire a workspace.
        for path in queued[1:]:
            status, row = api.request(path + "/cancel", "POST")
            self.assertEqual((status, row["started_at"], row["status"]), (200, None, "cancelled"))
            self.assertEqual(api.request(path + "/cancel", "POST")[1], row)
            self.assertFalse(self.work(path).exists())
        self.assertEqual(api.get(queued[0])["status"], "queued")
        for path, group in zip((first, second), groups):
            self.assertEqual(api.get(path + "/artifacts"), {"items": []})
            self.assertEqual(api.request(path + "/cancel", "POST")[0], 202)
            final = api.finished(path)
            self.assertEqual(final["status"], "cancelled")
            self.assertEqual(api.request(path + "/cancel", "POST")[1], final)
            for pid in group:
                until(lambda pid=pid: absent(pid))
            self.assertFalse(self.work(path).exists())
        self.assertEqual(api.finished(queued[0])["status"], "succeeded")

    def test_logs_exact_cap_and_invalid_utf8(self):
        for name, content in [
            ("exact", "b'A' * 65536"),
            ("over", "b'A' * 65536 + b'B'"),
            ("utf8", "b'A' * 65535 + '字'.encode()"),
        ]:
            self.fixture(name, f"import os\nos.write(2, {content})\nos._exit(0)\n")
        self.reload()
        for name in ("exact", "over", "utf8"):
            path = self.api.submit(name)
            self.assertEqual(self.api.finished(path)["status"], "succeeded")
            result = self.api.get(path + "/logs")
            self.assertEqual(result["truncated"], name != "exact")
            self.assertEqual(result["text"], "A" * 65536 if name != "utf8" else "A" * 65535 + "�")

    def test_flood_output_timeout(self):
        self.fixture(
            "flood",
            """
            import os
            while True:
                os.write(1, b'x' * 32768)
        """,
        )
        self.reload()
        path = self.api.submit("flood", timeout=1)
        row = self.api.finished(path)
        self.assertEqual((row["status"], row["stop_reason"]), ("timeout", "timeout"))
        log = self.api.get(path + "/logs")
        self.assertEqual((len(log["text"]), log["truncated"]), (65536, True))
        self.assertFalse(self.work(path).exists())

    def test_natural_exit_leaves_child_holding_pipe(self):
        self.fixture(
            "background",
            """
            import os, signal, time
            r, w = os.pipe()
            pid = os.fork()
            if pid == 0:
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                os.write(w, b'!')
                time.sleep(10)
                os._exit(0)
            os.read(r, 1)
            print(f'background={pid}', flush=True)
            os._exit(0)
        """,
        )
        self.reload()
        path = self.api.submit("background")
        row = self.api.finished(path)
        self.assertEqual((row["status"], row["exit_code"]), ("succeeded", 0))
        pid = int(re.search(r"background=(\d+)", self.api.get(path + "/logs")["text"])[1])
        until(lambda pid=pid: absent(pid))

    def test_reject_links_and_large_build(self):
        project = self.projects / "invalid"
        project.mkdir()
        (project / "__main__.py").symlink_to(self.projects / "hello/__main__.py")
        large = self.projects / "large"
        large.mkdir()
        (large / "__main__.py").write_text("pass")
        (large / "payload").write_bytes(b"x" * (5 * 1024 * 1024))
        self.reload()
        for name, code in [("invalid", "start_failed"), ("large", "artifact_invalid")]:
            path = self.api.submit(name, "build")
            row = self.api.finished(path)
            self.assertEqual((row["status"], row["error"]["code"]), ("failed", code))
            self.assertEqual(self.api.request(path + "/artifacts/app.pyz")[0], 404)
            self.assertFalse(self.work(path).exists())

    def test_graceful_shutdown_and_history(self):
        api = self.api
        good = api.submit(kind="build")
        record = api.finished(good)
        data = api.get(good + "/artifacts/app.pyz")
        first, second = api.submit("slow"), api.submit("slow")
        pids = [*self.ready(first), *self.ready(second)]
        waiting = api.submit()
        api.stop(signal.SIGINT)
        for pid in pids:
            until(lambda pid=pid: absent(pid))
        api.start()
        for path in (first, second):
            self.assertEqual(api.get(path)["stop_reason"], "service_shutdown")
            self.assertEqual(api.get(path)["status"], "cancelled")
        self.assertEqual(api.finished(waiting)["status"], "succeeded")
        self.assertEqual(api.get(good), record)
        self.assertEqual(api.get(good + "/artifacts/app.pyz"), data)

    def test_api_killed_runner_controls_its_own_deadline(self):
        api = self.api
        path = api.submit("slow", timeout=2)
        pids = self.ready(path)
        api.stop(signal.SIGKILL)
        for pid in pids:
            until(lambda pid=pid: absent(pid))
        until(lambda: not self.work(path).exists())
        api.start()
        self.assertEqual(api.finished(path)["status"], "timeout")

    def test_restart_with_live_runners_and_single_instance(self):
        api = self.api
        first, second = api.submit("slow"), api.submit("slow")
        groups = [self.ready(p) for p in (first, second)]
        other = LocalService(self.folder, self.projects)
        with self.assertRaisesRegex(RuntimeError, "另一个服务"):
            other.start()
        pending = api.submit()
        api.stop(signal.SIGKILL)
        api.start()
        self.assertEqual(api.get(pending)["status"], "queued")
        for path, group in zip((first, second), groups):
            self.assertEqual(api.get(path)["status"], "running")
            api.request(path + "/cancel", "POST")
            self.assertEqual(api.finished(path)["status"], "cancelled")
            for pid in group:
                until(lambda pid=pid: absent(pid))
        self.assertEqual(api.finished(pending)["status"], "succeeded")

    def test_lost_runner_quarantines_live_group(self):
        api = self.api
        path = api.submit("slow")
        leader, leaf = self.ready(path)
        runner = int(subprocess.check_output(["/bin/ps", "-p", str(leader), "-o", "ppid="]))
        try:
            os.kill(runner, signal.SIGKILL)
            until(lambda: api.get(path)["recovery_reason"] == "cleanup_unverified")
            self.assertFalse(absent(leaf))
            self.assertTrue(self.work(path).exists())
        finally:
            # Only the fixture owns and knows this live group. Simulate operator cleanup.
            os.killpg(leader, signal.SIGKILL)
        self.assertEqual(api.finished(path)["error"]["code"], "runner_lost")
        self.assertFalse(self.work(path).exists())

    def test_recover_staged_results_before_and_after_directory_removal(self):
        for remove in (False, True):
            api = self.api
            path = api.submit("slow")
            self.ready(path)
            workspace = self.work(path)
            # Force rmdir to fail after staging, without adding failpoints to the service.
            workspace.parent.chmod(0o500)
            try:
                api.request(path + "/cancel", "POST")
                until(lambda path=path: self.api.get(path)["recovery_reason"] == "cleanup_pending")
                self.assertEqual(api.get(path + "/artifacts"), {"items": []})
                api.stop(signal.SIGKILL)
            finally:
                workspace.parent.chmod(0o700)
            if remove:
                shutil.rmtree(workspace)
            api.start()
            self.assertEqual(api.finished(path)["status"], "cancelled")
            self.assertEqual(len(api.get(path + "/artifacts")["items"]), 1)
            self.assertFalse(workspace.exists())

    def test_cancel_racing_completion_preserves_published_result(self):
        self.fixture(
            "finish",
            """
            import os, time
            from pathlib import Path
            print("ready-to-finish", flush=True)
            while not Path("finish").exists():
                time.sleep(0.005)
            os._exit(0)
        """,
        )
        self.reload()
        for _ in range(5):
            path = self.api.submit("finish")
            until(lambda path=path: "ready-to-finish" in self.api.get(path + "/logs")["text"])
            (self.work(path) / "src/finish").touch()
            with concurrent.futures.ThreadPoolExecutor(4) as pool:
                results = list(
                    pool.map(lambda job: self.api.request(job + "/cancel", "POST"), [path] * 4)
                )
            self.assertTrue(all(status in (200, 202) for status, _ in results))
            row = self.api.finished(path)
            self.assertIn(row["status"], {"cancelled", "succeeded"})
            self.assertEqual(row["status"], self.api.get(path + "/artifacts/result.json")["status"])
            self.assertEqual(row, self.api.request(path + "/cancel", "POST")[1])

    def test_web_workbench_catalog_and_task_listing(self):
        api = self.api
        status, html = api.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"/static/app.js", html)
        self.assertEqual(api.request("/static/styles.css")[0], 200)
        self.assertEqual(api.request("/static/app.js")[0], 200)

        catalog = api.get("/projects")
        self.assertEqual((catalog["workers"], catalog["queue_limit"]), (2, 32))
        by_id = {item["id"]: item for item in catalog["projects"]}
        self.assertEqual(
            by_id["hello"], {"id": "hello", "has_tests": True, "has_main": True, "file_count": 4}
        )
        self.assertEqual(
            by_id["broken"], {"id": "broken", "has_tests": True, "has_main": False, "file_count": 3}
        )
        self.assertIn("pipeline", by_id)
        self.assertIn("logflood", by_id)
        hello_files = api.get("/projects/hello/files")
        self.assertIn("greeting.py", [f["path"] for f in hello_files["files"]])

        first = api.submit("hello", "test")
        second = api.submit("broken", "test")
        api.finished(first)
        api.finished(second)

        slow = api.submit("slow", "test")
        pids = self.ready(slow)
        try:
            listing = api.get("/tasks?limit=2")
            self.assertEqual(len(listing["items"]), 2)
            self.assertEqual(listing["running_count"], 1)
            self.assertEqual(listing["active_tasks"][0]["id"], slow.rsplit("/", 1)[1])
            passed = api.get("/tasks?status=succeeded")
            self.assertEqual([row["id"] for row in passed["items"]], [first.rsplit("/", 1)[1]])
            self.assertEqual(api.request("/tasks?status=invalid")[0], 422)
            self.assertEqual(api.request("/tasks?limit=0")[0], 422)

            telemetry = api.get("/telemetry")
            self.assertEqual(telemetry["slots"]["running"], 1)
            self.assertEqual(telemetry["slots"]["capacity"], 2)
            self.assertGreaterEqual(telemetry["slots"]["task_processes"], 2)
            self.assertGreater(telemetry["slots"]["task_rss_bytes"], 0)
            self.assertEqual(telemetry["sandbox"]["active_workspaces"], 1)
            self.assertGreaterEqual(telemetry["metrics"]["finished_tasks"], 2)
        finally:
            api.request(slow + "/cancel", "POST")
            api.finished(slow)
            for pid in pids:
                until(lambda pid=pid: absent(pid))

        idle_telemetry = api.get("/telemetry")
        self.assertEqual(idle_telemetry["slots"]["running"], 0)
        self.assertEqual(idle_telemetry["sandbox"]["active_workspaces"], 0)

    def test_inline_source_archive_upload_security_and_sse(self):
        api = self.api
        # Reject specifying both or neither of project_id and files
        self.assertEqual(
            api.request(
                "/tasks",
                "POST",
                {"project_id": "hello", "files": {"a.py": "x=1\n"}, "type": "lint"},
            )[0],
            422,
        )
        self.assertEqual(
            api.request("/tasks", "POST", {"files": {"../escape.py": "x=1"}, "type": "lint"})[0],
            422,
        )

        # Inline edited workspace execution + source inspection
        status, queued = api.request(
            "/tasks",
            "POST",
            {
                "label": "broken-fixed",
                "type": "test",
                "files": {
                    "tests/__init__.py": "",
                    "tests/test_sum.py": (
                        "import unittest\n"
                        "class FixedTest(unittest.TestCase):\n"
                        "    def test_ok(self):\n"
                        "        self.assertEqual(sum([12, 8]), 20)\n"
                    ),
                },
            },
        )
        self.assertEqual(status, 202)
        inline_path = "/tasks/" + queued["id"]
        inline_row = api.finished(inline_path)
        self.assertEqual((inline_row["status"], inline_row["source_kind"]), ("succeeded", "inline"))
        src_snapshot = api.get(inline_path + "/source")
        self.assertEqual(src_snapshot["source_kind"], "inline")
        self.assertEqual(len(src_snapshot["files"]), 2)

        # ZIP archive upload with macOS __MACOSX noise and single outer directory wrapper
        good_zip = io.BytesIO()
        with zipfile.ZipFile(good_zip, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("__MACOSX/._meta", b"ignored")
            zf.writestr("my_pkg/.DS_Store", b"ignored")
            zf.writestr("my_pkg/__main__.py", 'print("From ZIP!")\n')
        status, zq = api.request(
            "/tasks/archive?type=build&filename=my_pkg.zip",
            "POST",
            good_zip.getvalue(),
            "application/zip",
        )
        self.assertEqual(status, 202)
        zip_path = "/tasks/" + zq["id"]
        zip_row = api.finished(zip_path)
        self.assertEqual((zip_row["status"], zip_row["source_kind"]), ("succeeded", "archive"))
        built = self.folder / "from_zip.pyz"
        built.write_bytes(api.get(zip_path + "/artifacts/app.pyz"))
        self.assertEqual(
            subprocess.check_output([sys.executable, built], text=True), "From ZIP!\n"
        )

        # SSE stream emits state/logs and closes on terminal completion
        sse_task = api.submit("hello", "test")
        status_code, sse_raw = api.request(sse_task + "/events")
        self.assertEqual(status_code, 200)
        frames = [
            json.loads(line.removeprefix("data: "))
            for line in sse_raw.decode().splitlines()
            if line.startswith("data: ")
        ]
        self.assertTrue(frames)
        self.assertEqual(frames[-1]["task"]["status"], "succeeded")
        self.assertIn("OK", frames[-1]["logs"]["text"])

        # Reject zip-slip traversal and symlink inside uploaded ZIP
        slip_zip = io.BytesIO()
        with zipfile.ZipFile(slip_zip, "w") as zf:
            zf.writestr("../evil.py", "pass")
        self.assertEqual(
            api.request("/tasks/archive?type=lint", "POST", slip_zip.getvalue(), "application/zip")[0],
            422,
        )

        link_zip = io.BytesIO()
        with zipfile.ZipFile(link_zip, "w") as zf:
            info = zipfile.ZipInfo("link.py")
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, "/etc/passwd")
        self.assertEqual(
            api.request("/tasks/archive?type=lint", "POST", link_zip.getvalue(), "application/zip")[0],
            422,
        )

    def test_history_expiry(self):
        expired = self.api.submit(kind="build")
        keep = self.api.submit()
        self.api.finished(expired)
        fresh = self.api.finished(keep)
        self.api.stop()
        # Age one completed record between real launches, avoiding a seven-day sleep.
        task_id = expired.rsplit("/", 1)[1]
        self.database("UPDATE tasks SET finished_at='2000-01-01T00:00:00Z' WHERE id=?", (task_id,))
        self.api.start()
        until(lambda: self.api.request(expired)[0] == 404)
        self.assertEqual(self.api.get(keep), fresh)
        self.assertEqual(self.api.request(expired + "/artifacts/app.pyz")[0], 404)
        self.assertEqual(self.database("SELECT name FROM artifacts WHERE task_id=?", (task_id,)), [])
        self.assertFalse((self.api.data / "locks" / task_id).exists())
