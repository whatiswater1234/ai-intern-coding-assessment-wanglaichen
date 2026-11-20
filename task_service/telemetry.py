"""Real-time macOS process-group, workspace hygiene and SQLite storage telemetry."""

import os
import subprocess
from datetime import datetime
from pathlib import Path

from .archive import ARCHIVE_LIMIT
from .storage import ARTIFACT_LIMIT, LOG_LIMIT, QUEUE_LIMIT, WORKERS, connect


def _dir_bytes(path: Path) -> int:
    total = 0
    try:
        if not path.exists():
            return 0
        for root_dir, _, files in os.walk(path, followlinks=False):
            base = Path(root_dir)
            for name in files:
                try:
                    total += (base / name).lstat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _read_ps_snapshot() -> tuple[dict[int, list[tuple[int, float]]], int]:
    """Return ({pgid: [(rss_bytes, cpu_pct), ...]}, api_rss_bytes) for live processes."""
    groups: dict[int, list[tuple[int, float]]] = {}
    api_pid = os.getpid()
    api_rss = 0
    try:
        table = subprocess.check_output(
            ["/bin/ps", "-axo", "pid=,pgid=,rss=,pcpu=,state="], text=True
        )
    except (OSError, subprocess.SubprocessError):
        return groups, 0

    for line in table.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            pid = int(parts[0])
            pgid = int(parts[1])
            rss_bytes = int(parts[2]) * 1024
            cpu_pct = float(parts[3])
            state = parts[4]
        except ValueError:
            continue
        if pid == api_pid:
            api_rss = rss_bytes
        if not state.startswith("Z"):
            groups.setdefault(pgid, []).append((rss_bytes, cpu_pct))
    return groups, api_rss


def _iso_ms(start_iso: str | None, end_iso: str | None) -> float | None:
    if not start_iso or not end_iso:
        return None
    try:
        s = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
        e = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
        return max(0.0, (e - s).total_seconds() * 1000.0)
    except ValueError:
        return None


def collect_telemetry(root: Path) -> dict:
    ps_groups, api_rss = _read_ps_snapshot()
    cpu_cores = os.cpu_count() or 1
    try:
        load_1m, load_5m, _ = os.getloadavg()
    except OSError:
        load_1m = load_5m = 0.0

    with connect(root) as db:
        running_rows = db.execute(
            """SELECT id, project_id, type, started_at, timeout_seconds,
                      command_pid, recovery_reason, decision
               FROM tasks WHERE status='running' ORDER BY seq ASC"""
        ).fetchall()
        counts_raw = dict(
            db.execute("SELECT status, count(*) FROM tasks GROUP BY status").fetchall()
        )
        recent_done = db.execute(
            """SELECT created_at, started_at, finished_at
               FROM tasks WHERE finished_at IS NOT NULL
               ORDER BY seq DESC LIMIT 40"""
        ).fetchall()

    worker_details = []
    total_worker_rss = 0
    total_worker_cpu = 0.0
    total_task_procs = 0

    for row in running_rows:
        pgid = row["command_pid"]
        members = ps_groups.get(pgid, []) if pgid else []
        rss = sum(m[0] for m in members)
        cpu = round(sum(m[1] for m in members), 1)
        proc_cnt = len(members)
        ws_bytes = _dir_bytes(root / "work" / row["id"])

        total_worker_rss += rss
        total_worker_cpu += cpu
        total_task_procs += proc_cnt

        worker_details.append(
            {
                "task_id": row["id"],
                "project_id": row["project_id"],
                "type": row["type"],
                "pgid": pgid,
                "process_count": proc_cnt,
                "rss_bytes": rss,
                "cpu_percent": cpu,
                "workspace_bytes": ws_bytes,
                "stopping": bool(row["decision"]),
            }
        )

    work_root = root / "work"
    try:
        active_workspaces = sum(1 for p in work_root.iterdir() if p.is_dir()) if work_root.is_dir() else 0
    except OSError:
        active_workspaces = 0

    quarantined = sum(1 for r in running_rows if r["recovery_reason"] is not None)

    queue_samples = []
    exec_samples = []
    for r in recent_done:
        q_ms = _iso_ms(r["created_at"], r["started_at"])
        e_ms = _iso_ms(r["started_at"], r["finished_at"])
        if q_ms is not None:
            queue_samples.append(q_ms)
        if e_ms is not None:
            exec_samples.append(e_ms)

    avg_queue_ms = round(sum(queue_samples) / len(queue_samples), 1) if queue_samples else 0.0
    avg_exec_ms = round(sum(exec_samples) / len(exec_samples), 1) if exec_samples else 0.0

    storage_bytes = 0
    for suffix in ("tasks.sqlite3", "tasks.sqlite3-wal", "tasks.sqlite3-shm"):
        p = root / suffix
        try:
            if p.exists():
                storage_bytes += p.stat().st_size
        except OSError:
            pass

    succeeded = counts_raw.get("succeeded", 0)
    failed = counts_raw.get("failed", 0)
    cancelled = counts_raw.get("cancelled", 0)
    timeout = counts_raw.get("timeout", 0)
    queued = counts_raw.get("queued", 0)
    running = counts_raw.get("running", 0)
    finished_total = succeeded + failed + cancelled + timeout

    return {
        "host": {
            "cpu_cores": cpu_cores,
            "load_1m": round(load_1m, 2),
            "load_5m": round(load_5m, 2),
            "load_ratio_percent": min(100.0, round((load_1m / cpu_cores) * 100.0, 1)),
            "api_rss_bytes": api_rss,
        },
        "slots": {
            "running": running,
            "capacity": WORKERS,
            "queued": queued,
            "queue_limit": QUEUE_LIMIT,
            "task_processes": total_task_procs,
            "task_rss_bytes": total_worker_rss,
            "task_cpu_percent": round(total_worker_cpu, 1),
            "active_workers": worker_details,
        },
        "sandbox": {
            "active_workspaces": active_workspaces,
            "quarantined_tasks": quarantined,
            "log_limit_bytes": LOG_LIMIT,
            "artifact_limit_bytes": ARTIFACT_LIMIT,
            "archive_limit_bytes": ARCHIVE_LIMIT,
        },
        "metrics": {
            "total_tasks": finished_total + queued + running,
            "finished_tasks": finished_total,
            "succeeded": succeeded,
            "failed": failed,
            "cancelled": cancelled,
            "timeout": timeout,
            "avg_queue_ms": avg_queue_ms,
            "avg_exec_ms": avg_exec_ms,
            "storage_bytes": storage_bytes,
        },
    }
