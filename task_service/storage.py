"""Durable queue and result publication, shared by the API and task runners."""

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

LOG_LIMIT = 64 * 1024
ARTIFACT_LIMIT = 5 * 1024 * 1024
WORKERS = 2
QUEUE_LIMIT = 32

TASK_SELECT = """
    SELECT tasks.*, COALESCE(task_sources.source_kind, 'preset') AS source_kind
    FROM tasks
    LEFT JOIN task_sources ON task_sources.task_id = tasks.id
"""


class ServiceError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code


def now():
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@contextmanager
def connect(root: Path, *, write=False):
    db = sqlite3.connect(root / "tasks.sqlite3", timeout=2, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys=ON")
        if write:
            db.execute("BEGIN IMMEDIATE")
        yield db
        if write:
            db.commit()
    finally:
        db.close()


def initialize(root):
    with connect(root) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (
                seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
                project_id TEXT NOT NULL, type TEXT NOT NULL, timeout_seconds INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL,
                started_at TEXT, finished_at TEXT, deadline REAL, decision TEXT,
                command_intent INTEGER NOT NULL DEFAULT 0, command_pid INTEGER, boot_id TEXT,
                staged_status TEXT, exit_code INTEGER, error TEXT, recovery_reason TEXT,
                log BLOB NOT NULL DEFAULT X'', truncated INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS queue ON tasks(status, seq);
            CREATE TABLE IF NOT EXISTS artifacts (
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                name TEXT NOT NULL, media_type TEXT NOT NULL, content BLOB NOT NULL,
                PRIMARY KEY (task_id, name)
            );
            CREATE TABLE IF NOT EXISTS task_sources (
                task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
                source_kind TEXT NOT NULL,
                archive BLOB NOT NULL
            );
        """)


def task(db, task_id):
    row = db.execute(f"{TASK_SELECT} WHERE tasks.id=?", (task_id,)).fetchone()
    if row is None:
        raise ServiceError(404, "task_not_found", "任务不存在")
    return row


def snapshot(row):
    fields = (
        "id",
        "type",
        "project_id",
        "source_kind",
        "timeout_seconds",
        "status",
        "created_at",
        "started_at",
        "finished_at",
        "recovery_reason",
    )
    result = {key: row[key] for key in fields}
    visible = row["finished_at"] is not None
    result["exit_code"] = row["exit_code"] if visible else None
    result["error"] = json.loads(row["error"]) if visible and row["error"] else None
    reason = row["decision"]
    result["stop_reason"] = reason if reason in ("cancelled", "timeout", "service_shutdown") else None
    return result


def list_tasks(root, limit=50, status=None):
    with connect(root) as db:
        running_rows = db.execute(
            f"{TASK_SELECT} WHERE tasks.status='running' ORDER BY tasks.seq ASC"
        ).fetchall()
        queued_count = db.execute(
            "SELECT count(*) FROM tasks WHERE status='queued'"
        ).fetchone()[0]
        if status is None:
            rows = db.execute(
                f"{TASK_SELECT} ORDER BY tasks.seq DESC LIMIT ?", (limit,)
            ).fetchall()
        else:
            rows = db.execute(
                f"{TASK_SELECT} WHERE tasks.status=? ORDER BY tasks.seq DESC LIMIT ?",
                (status, limit),
            ).fetchall()
    return {
        "items": [snapshot(row) for row in rows],
        "active_tasks": [snapshot(row) for row in running_rows],
        "running_count": len(running_rows),
        "queued_count": queued_count,
        "workers": WORKERS,
        "queue_limit": QUEUE_LIMIT,
    }


def enqueue(root, project_id, kind, timeout, *, source_kind="preset", archive=None):
    task_id = str(uuid.uuid4())
    with connect(root, write=True) as db:
        count = db.execute("SELECT count(*) FROM tasks WHERE status='queued'").fetchone()[0]
        if count >= QUEUE_LIMIT:
            raise ServiceError(429, "queue_full", "等待队列已满")
        db.execute(
            """INSERT INTO tasks(id,project_id,type,timeout_seconds,created_at)
                      VALUES (?,?,?,?,?)""",
            (task_id, project_id, kind, timeout, now()),
        )
        if archive is not None:
            db.execute(
                "INSERT INTO task_sources(task_id,source_kind,archive) VALUES (?,?,?)",
                (task_id, source_kind, archive),
            )
    return task_id


def decide(db, task_id, reason):
    """Serialize observed completion, cancel and deadline in the same write transaction."""
    db.execute(
        """UPDATE tasks SET decision=CASE WHEN deadline<=? THEN 'timeout' ELSE ? END
                  WHERE id=? AND status='running' AND decision IS NULL""",
        (time.monotonic(), reason, task_id),
    )
    return task(db, task_id)["decision"]


def cancel(root, task_id, reason="cancelled"):
    with connect(root, write=True) as db:
        row = task(db, task_id)
        if row["status"] == "queued":
            db.execute(
                "UPDATE tasks SET status='cancelled', decision=?, finished_at=? WHERE id=?",
                (reason, now(), task_id),
            )
        elif row["status"] == "running":
            decide(db, task_id, reason)
        return snapshot(task(db, task_id))


def stage(root, task_id, rc, error=None, archive=None):
    with connect(root, write=True) as db:
        decision = decide(db, task_id, "exited")
        if decision in ("cancelled", "service_shutdown", "timeout"):
            status = "timeout" if decision == "timeout" else "cancelled"
            error = {
                "code": decision,
                "message": {
                    "timeout": "超过执行时限",
                    "cancelled": "用户取消任务",
                    "service_shutdown": "服务正常关闭",
                }[decision],
            }
        elif error or rc != 0:
            status = "failed"
            error = error or {"code": "nonzero_exit", "message": f"命令退出码为 {rc}"}
        else:
            status = "succeeded"
        current = task(db, task_id)
        report = {
            "id": task_id,
            "project_id": current["project_id"],
            "source_kind": current["source_kind"],
            "type": current["type"],
            "status": status,
            "exit_code": rc,
            "started_at": current["started_at"],
            "error": error,
        }
        db.execute(
            "INSERT INTO artifacts VALUES(?,?,?,?)",
            (
                task_id,
                "result.json",
                "application/json",
                json.dumps(report, ensure_ascii=False).encode(),
            ),
        )
        if status == "succeeded" and archive is not None:
            db.execute(
                "INSERT INTO artifacts VALUES(?,?,?,?)",
                (task_id, "app.pyz", "application/zip", archive),
            )
        db.execute(
            """UPDATE tasks SET staged_status=?, exit_code=?, error=?, command_intent=0
                      WHERE id=?""",
            (status, rc, json.dumps(error) if error else None, task_id),
        )
