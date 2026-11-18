"""Own a single macOS process group until its logs, artifacts and workspace are settled."""

import os
import select
import shutil
import signal
import stat
import subprocess
import sys
import time
from contextlib import closing
from pathlib import Path

from .storage import ARTIFACT_LIMIT, LOG_LIMIT, connect, decide, now, stage, task


class PreparationStopped(Exception):
    """An accepted stop request or deadline was observed before launching the command."""


def copy_project(source, target, root, row):
    if source.is_symlink() or not source.is_dir():
        raise ValueError("预置项目目录无效")
    next_check = 0.0

    def checkpoint():
        nonlocal next_check
        stamp = time.monotonic()
        if stamp >= row["deadline"]:
            raise PreparationStopped
        if stamp >= next_check:
            with connect(root) as db:
                if task(db, row["id"])["decision"]:
                    raise PreparationStopped
            next_check = stamp + 0.08

    # Iterative traversal avoids Python's recursion limit for deep project trees.
    pending = [(source, target)]
    while pending:
        directory, destination = pending.pop()
        checkpoint()
        destination.mkdir()
        for item in directory.iterdir():
            checkpoint()
            path = destination / item.name
            mode = item.lstat().st_mode
            if stat.S_ISDIR(mode):
                pending.append((item, path))
            elif stat.S_ISREG(mode):
                with item.open("rb") as reader, path.open("xb") as writer:
                    while chunk := reader.read(256 * 1024):
                        checkpoint()
                        writer.write(chunk)
            else:
                raise ValueError("预置项目只接受普通文件和目录")


def read_archive(output):
    directory = os.open(output, os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open("app.pyz", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, "rb") as source:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError("归档必须为普通文件")
            data = source.read(ARTIFACT_LIMIT + 1)
            if len(data) > ARTIFACT_LIMIT:
                raise ValueError("归档超过 5 MiB")
            return data
    finally:
        os.close(directory)


class LogCapture:
    def __init__(self, stream):
        self.fd = stream.fileno()
        os.set_blocking(self.fd, False)
        self.data = bytearray()
        self.saved = 0
        self.eof = False

    def drain(self):
        # Bound each turn even when the producer continuously fills the pipe.
        for _ in range(16):
            try:
                chunk = os.read(self.fd, 65536)
            except BlockingIOError:
                break
            if not chunk:
                self.eof = True
                break
            self.data.extend(chunk[: LOG_LIMIT + 1 - len(self.data)])

    def flush(self, root, task_id):
        if self.saved != len(self.data):
            with connect(root, write=True) as db:
                db.execute(
                    "UPDATE tasks SET log=?,truncated=? WHERE id=?",
                    (self.data[:LOG_LIMIT], len(self.data) > LOG_LIMIT, task_id),
                )
            self.saved = len(self.data)


def live_group(pid):
    table = subprocess.check_output(["/bin/ps", "-axo", "pgid=,state="], text=True)
    for line in table.splitlines():
        group, state = line.split()
        if int(group) == pid and not state.startswith("Z"):
            return True
    return False


def group_signal(pid, sig):
    try:
        os.killpg(pid, sig)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Darwin returns EPERM even to the parent for a zombie-only group.
        # The unreaped leader pins the PGID while we inspect member states.
        if live_group(pid):
            raise
        return False


class GroupUnverified(RuntimeError):
    """Leave the intent marker for the scheduler if teardown could not be verified."""


def stop_group(process):
    try:
        if group_signal(process.pid, signal.SIGTERM):
            time.sleep(0.1)
            if group_signal(process.pid, signal.SIGKILL):
                deadline = time.monotonic() + 1
                while live_group(process.pid):
                    if time.monotonic() >= deadline:
                        raise GroupUnverified("进程组仍有活动成员")
                    time.sleep(0.02)
        process.wait(timeout=1)
    except (OSError, subprocess.SubprocessError) as exc:
        raise GroupUnverified("无法确认进程组已退出") from exc


def monitor(process, root, row):
    log = LogCapture(process.stdout)
    next_check = 0.0
    try:
        with closing(select.kqueue()) as queue:
            events = [
                select.kevent(
                    process.pid,
                    filter=select.KQ_FILTER_PROC,
                    flags=select.KQ_EV_ADD,
                    fflags=select.KQ_NOTE_EXIT,
                ),
                select.kevent(log.fd, filter=select.KQ_FILTER_READ, flags=select.KQ_EV_ADD),
            ]
            exited = False
            try:
                queue.control(events, 0)
            except ProcessLookupError:
                exited = True  # Short-lived leader already exited, still unreaped.
            while True:
                stamp = time.monotonic()
                if exited or stamp >= next_check or stamp >= row["deadline"]:
                    log.flush(root, row["id"])
                    if exited or stamp >= row["deadline"]:
                        with connect(root, write=True) as db:
                            decide(db, row["id"], "exited" if exited else "timeout")
                        break
                    with connect(root) as db:
                        if task(db, row["id"])["decision"]:
                            break
                    next_check = stamp + 0.08
                for event in queue.control(None, 2, max(0, min(next_check, row["deadline"]) - stamp)):
                    if event.filter == select.KQ_FILTER_PROC:
                        exited = True
                    elif event.filter == select.KQ_FILTER_READ:
                        log.drain()
                        if log.eof:
                            queue.control(
                                [
                                    select.kevent(
                                        log.fd, filter=select.KQ_FILTER_READ, flags=select.KQ_EV_DELETE
                                    )
                                ],
                                0,
                            )
    finally:
        # Keep the group leader unreaped until the last group-directed signal.
        try:
            stop_group(process)
            end = time.monotonic() + 0.5
            while not log.eof and time.monotonic() < end:
                log.drain()
                if not log.eof:
                    time.sleep(0.005)
            log.flush(root, row["id"])
        finally:
            process.stdout.close()
    return process.returncode


def publish(root, task_id):
    workspace = root / "work" / task_id
    if workspace.exists():
        shutil.rmtree(workspace)
    with connect(root, write=True) as db:
        db.execute(
            """UPDATE tasks SET status=staged_status,finished_at=?,recovery_reason=NULL
                      WHERE id=? AND status='running' AND staged_status IS NOT NULL""",
            (now(), task_id),
        )


def run(root, projects, task_id):
    with connect(root) as db:
        row = task(db, task_id)
    work = root / "work" / task_id
    src, output, temp = work / "src", work / "out", work / "tmp"
    rc = error = archive = None
    phase = "start_failed"
    try:
        work.mkdir(mode=0o700)
        output.mkdir()
        temp.mkdir()
        copy_project(projects / row["project_id"], src, root, row)
        args = {
            "lint": ["-I", "-m", "compileall", "-q", "."],
            "test": ["-I", "-B", "-u", "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-v"],
            "build": ["-I", "-m", "zipapp", ".", "-o", str(output / "app.pyz")],
        }[row["type"]]
        with connect(root, write=True) as db:
            if time.monotonic() >= row["deadline"]:
                decide(db, task_id, "timeout")
            launch = not task(db, task_id)["decision"]
            if launch:
                db.execute("UPDATE tasks SET command_intent=1 WHERE id=?", (task_id,))
        if launch:
            process = subprocess.Popen(
                [sys.executable, *args],
                cwd=src,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                env={
                    "PATH": os.defpath,
                    "HOME": str(temp),
                    "TMPDIR": str(temp),
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "PYTHONUTF8": "1",
                },
            )
            phase = "runner_error"
            try:
                with connect(root, write=True) as db:
                    db.execute("UPDATE tasks SET command_pid=? WHERE id=?", (process.pid, task_id))
            except BaseException:
                group_signal(process.pid, signal.SIGKILL)
                process.wait()
                process.stdout.close()
                raise
            rc = monitor(process, root, row)
            if rc == 0 and row["type"] == "build":
                phase = "artifact_invalid"
                archive = read_archive(output)
    except PreparationStopped:
        pass  # stage() resolves the stored decision or elapsed deadline.
    except (OSError, ValueError) as exc:
        error = {"code": phase, "message": exc.strerror if isinstance(exc, OSError) else str(exc)}
    stage(root, task_id, rc, error, archive)
    publish(root, task_id)


if __name__ == "__main__":
    run(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
