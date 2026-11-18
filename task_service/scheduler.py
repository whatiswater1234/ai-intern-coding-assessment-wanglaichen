import fcntl
import logging
import sqlite3
import subprocess
import sys
import threading
import time
from contextlib import contextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .runner import live_group, publish
from .storage import WORKERS, cancel, connect, initialize, now, stage, task

REPO = Path(__file__).resolve().parent.parent
LOG = logging.getLogger("uvicorn.error")


@contextmanager
def try_lock(path):
    with path.open("ab") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield None
        else:
            # Close rather than LOCK_UN: the runner may own an inherited duplicate.
            yield handle


class Scheduler:
    def __init__(self, root, projects):
        self.root = root
        self.projects = projects
        self.stop = threading.Event()
        self.children = []
        self.next_expiry = 0
        self.boot_id = subprocess.check_output(
            ["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], text=True
        ).strip()
        self.next_group_check = {}

    @contextmanager
    def service(self):
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        with try_lock(self.root / "api.lock") as lock:
            if lock is None:
                raise RuntimeError("数据目录正由另一个服务使用")
            for name in ("work", "locks"):
                (self.root / name).mkdir(mode=0o700, exist_ok=True)
            initialize(self.root)
            self.reconcile()
            thread = threading.Thread(target=self.loop, name="task-scheduler")
            thread.start()
            try:
                yield
            finally:
                self.stop.set()
                thread.join()
                with connect(self.root) as db:
                    running = self.running(db)
                for row in running:
                    cancel(self.root, row["id"], "service_shutdown")
                limit = time.monotonic() + 5
                while time.monotonic() < limit:
                    self.reconcile()
                    with connect(self.root) as db:
                        if not any(r["recovery_reason"] is None for r in self.running(db)):
                            break
                    time.sleep(0.05)
                for child in self.children:
                    with suppress(subprocess.TimeoutExpired):
                        child.wait(timeout=0.5)

    @staticmethod
    def running(db):
        return db.execute("SELECT id,recovery_reason FROM tasks WHERE status='running'").fetchall()

    def lease(self, task_id):
        return try_lock(self.root / "locks" / task_id)

    def reconcile(self):
        self.children = [p for p in self.children if p.poll() is None]
        with connect(self.root) as db:
            rows = self.running(db)
        for row in rows:
            task_id = row["id"]
            with self.lease(task_id) as lease:
                if lease is None:
                    continue
                with connect(self.root) as db:
                    current = task(db, task_id)
                if current["status"] != "running":
                    continue
                lost = current["command_intent"]
                if lost and current["boot_id"] == self.boot_id:
                    if time.monotonic() < self.next_group_check.get(task_id, 0):
                        continue
                    group = current["command_pid"]
                    if group is None or live_group(group):
                        self.next_group_check[task_id] = time.monotonic() + 1
                        if current["recovery_reason"] != "cleanup_unverified":
                            with connect(self.root, write=True) as db:
                                db.execute(
                                    "UPDATE tasks SET recovery_reason='cleanup_unverified' WHERE id=?",
                                    (task_id,),
                                )
                            LOG.error("Runner lost for %s; inspect command group %s", task_id, group)
                        continue
                self.next_group_check.pop(task_id, None)
                if not current["staged_status"]:
                    stage(
                        self.root,
                        task_id,
                        None,
                        {
                            "code": "runner_lost" if lost else "service_interrupted",
                            "message": "执行器已中断",
                        },
                    )
                try:
                    publish(self.root, task_id)
                except OSError:
                    with connect(self.root, write=True) as db:
                        db.execute(
                            "UPDATE tasks SET recovery_reason='cleanup_pending' WHERE id=?", (task_id,)
                        )

    def start_one(self):
        with connect(self.root) as db:
            if len(self.running(db)) >= WORKERS:
                return False
            first = db.execute(
                "SELECT id FROM tasks WHERE status='queued' ORDER BY seq LIMIT 1"
            ).fetchone()
        if first is None:
            return False
        task_id = first["id"]
        with self.lease(task_id) as lease:
            if lease is None:
                return False
            with connect(self.root, write=True) as db:
                changed = db.execute(
                    """UPDATE tasks SET status='running',started_at=?,
                                        deadline=?+timeout_seconds,boot_id=? WHERE id=? AND status='queued'""",
                    (now(), time.monotonic(), self.boot_id, task_id),
                )
                if not changed.rowcount:
                    return True
            runner = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "task_service.runner",
                    str(self.root),
                    str(self.projects),
                    task_id,
                ],
                cwd=REPO,
                pass_fds=(lease.fileno(),),
                start_new_session=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.children.append(runner)
            return True

    def expire(self):
        cutoff = (
            (datetime.now(UTC) - timedelta(days=7))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        with connect(self.root, write=True) as db:
            rows = db.execute(
                "SELECT id FROM tasks WHERE finished_at < ? LIMIT 128", (cutoff,)
            ).fetchall()
            for row in rows:
                (self.root / "locks" / row["id"]).unlink(missing_ok=True)
                db.execute("DELETE FROM tasks WHERE id=?", (row["id"],))
        self.next_expiry = time.monotonic() + (1 if len(rows) == 128 else 600)

    def loop(self):
        while not self.stop.is_set():
            try:
                self.reconcile()
                if time.monotonic() >= self.next_expiry:
                    self.expire()
                while not self.stop.is_set() and self.start_one():
                    pass
            except (sqlite3.Error, OSError):
                LOG.exception("Scheduler will retry")
                self.stop.wait(1)
            self.stop.wait(0.10)
