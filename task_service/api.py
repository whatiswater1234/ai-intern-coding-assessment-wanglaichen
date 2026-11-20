import asyncio
import json
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .archive import (
    ARCHIVE_LIMIT,
    inspect_archive_files,
    inspect_directory_files,
    normalize_zip_archive,
    pack_inline_files,
)
from .models import (
    Artifacts,
    CreateTask,
    QueuedTask,
    ServiceCatalog,
    TaskCollection,
    TaskLogs,
    TaskSource,
    TaskState,
    TaskStatus,
    TaskType,
)
from .scheduler import Scheduler
from .storage import (
    ARTIFACT_LIMIT,
    LOG_LIMIT,
    QUEUE_LIMIT,
    WORKERS,
    ServiceError,
    cancel,
    connect,
    enqueue,
    list_tasks,
    snapshot,
    task,
)
from .telemetry import collect_telemetry

WEB_DIR = Path(__file__).resolve().parent / "web"
JSON_BODY_LIMIT = 8192


def error_response(status, code, message):
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


class RequestLimits:
    """Cap streamed request bodies before parsing, including chunked transfers."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] == "POST":
            headers = dict(scope["headers"])
            origin = headers.get(b"origin")
            if origin and origin != b"http://" + headers.get(b"host", b""):
                return await error_response(403, "origin_denied", "仅接受本机同源请求")(
                    scope, receive, send
                )
            route_path = scope["path"].rstrip("/")
            if route_path in ("/tasks", "/tasks/archive"):
                media = headers.get(b"content-type", b"").partition(b";")[0].strip().lower()
                if route_path == "/tasks":
                    if media != b"application/json":
                        return await error_response(415, "media_type", "需要 application/json")(
                            scope, receive, send
                        )
                    limit = JSON_BODY_LIMIT
                    limit_label = "8 KiB"
                else:
                    if media not in (b"application/zip", b"application/octet-stream"):
                        return await error_response(
                            415, "media_type", "需要 application/zip 或 application/octet-stream"
                        )(scope, receive, send)
                    limit = ARCHIVE_LIMIT
                    limit_label = "2 MiB"

                body = bytearray()
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    chunk = message.get("body", b"")
                    if len(body) + len(chunk) > limit:
                        return await error_response(
                            413, "body_limit", f"请求超过 {limit_label}"
                        )(scope, receive, send)
                    body.extend(chunk)
                    if not message.get("more_body"):
                        break
                sent = False

                async def buffered_receive():
                    nonlocal sent
                    if sent:
                        return await receive()
                    sent = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}

                return await self.app(scope, buffered_receive, send)
        await self.app(scope, receive, send)


def build_app(root, projects):
    scheduler = Scheduler(root, projects)
    if projects == root or any(
        root.is_relative_to(p) for p in projects.iterdir() if p.is_dir() and not p.name.startswith(".")
    ):
        raise ValueError("数据目录须位于所有预置项目以外")
    catalog = {
        p.name
        for p in projects.iterdir()
        if p.is_dir() and not p.is_symlink() and not p.name.startswith(".")
    }

    @asynccontextmanager
    async def lifespan(app):
        with scheduler.service():
            yield

    app = FastAPI(title="本机代码任务执行服务", version="1.0", lifespan=lifespan)
    app.add_middleware(RequestLimits)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        return error_response(exc.status_code, "http_error", str(exc.detail))

    @app.exception_handler(ServiceError)
    async def service_error(request: Request, exc: ServiceError):
        return error_response(exc.status, exc.code, str(exc))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        first = exc.errors()[0]
        if first["type"] == "json_invalid":
            return error_response(400, "invalid_json", "JSON 格式错误")
        return error_response(
            422, "invalid_input", f"{'.'.join(map(str, first['loc']))}: {first['msg']}"
        )

    @app.exception_handler(sqlite3.OperationalError)
    async def storage_error(request: Request, exc: sqlite3.OperationalError):
        return error_response(503, "storage_unavailable", "本地存储暂不可用")

    if WEB_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

        @app.get("/", include_in_schema=False)
        def index():
            return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/telemetry", summary="查询系统资源、执行槽进程组与沙箱健康指标")
    def telemetry():
        return collect_telemetry(root)

    @app.get("/projects", response_model=ServiceCatalog, summary="查询预置项目与运行配额")
    def list_projects():
        items = []
        for name in sorted(catalog):
            folder = projects / name
            tests_dir = folder / "tests"
            main_file = folder / "__main__.py"
            try:
                file_count = len(inspect_directory_files(folder))
            except (OSError, ServiceError):
                file_count = 0
            items.append(
                {
                    "id": name,
                    "has_tests": not tests_dir.is_symlink() and tests_dir.is_dir(),
                    "has_main": not main_file.is_symlink() and main_file.is_file(),
                    "file_count": file_count,
                }
            )
        return {
            "projects": items,
            "task_types": ["lint", "test", "build"],
            "workers": WORKERS,
            "queue_limit": QUEUE_LIMIT,
            "log_limit_bytes": LOG_LIMIT,
            "artifact_limit_bytes": ARTIFACT_LIMIT,
            "archive_limit_bytes": ARCHIVE_LIMIT,
        }

    @app.get("/projects/{project_id}/files", response_model=TaskSource, summary="查看预置项目源码")
    def project_files(project_id: str):
        if project_id not in catalog:
            raise ServiceError(404, "project_not_found", "预置项目不存在")
        return {
            "label": project_id,
            "source_kind": "preset",
            "files": inspect_directory_files(projects / project_id),
        }

    @app.get("/tasks", response_model=TaskCollection, summary="列出最近任务与队列状态")
    def collection(
        limit: int = Query(default=50, ge=1, le=200),
        status: TaskStatus | None = Query(default=None),
    ):
        return list_tasks(root, limit=limit, status=status)

    @app.post("/tasks", status_code=202, response_model=QueuedTask, summary="提交任务")
    def create(body: CreateTask, response: Response):
        if body.project_id is not None:
            if body.project_id not in catalog:
                raise ServiceError(
                    422, "unknown_project", "未知项目，可选：" + "、".join(sorted(catalog))
                )
            task_id = enqueue(root, body.project_id, body.type, body.timeout_seconds)
        else:
            archive = pack_inline_files(body.files)
            label = (body.label or "inline-workspace").strip()
            task_id = enqueue(
                root,
                label,
                body.type,
                body.timeout_seconds,
                source_kind="inline",
                archive=archive,
            )
        response.headers["Location"] = f"/tasks/{task_id}"
        return {"id": task_id, "status": "queued"}

    @app.post(
        "/tasks/archive",
        status_code=202,
        response_model=QueuedTask,
        summary="上传本地 ZIP 代码包创建任务",
    )
    async def create_from_archive(
        request: Request,
        response: Response,
        type: TaskType = Query(...),
        timeout_seconds: int = Query(default=30, ge=1, le=300),
        filename: str = Query(default="archive.zip", min_length=1, max_length=80),
    ):
        raw = await request.body()
        normalized = normalize_zip_archive(raw)
        clean_name = Path(filename).name or "archive.zip"
        task_id = enqueue(
            root,
            clean_name[:80],
            type,
            timeout_seconds,
            source_kind="archive",
            archive=normalized,
        )
        response.headers["Location"] = f"/tasks/{task_id}"
        return {"id": task_id, "status": "queued"}

    @app.get("/tasks/{task_id}", response_model=TaskState, summary="查询状态")
    def status(task_id: str):
        with connect(root) as db:
            return snapshot(task(db, task_id))

    @app.get("/tasks/{task_id}/source", response_model=TaskSource, summary="查看任务执行源码")
    def source(task_id: str):
        with connect(root) as db:
            row = task(db, task_id)
            source_row = db.execute(
                "SELECT source_kind, archive FROM task_sources WHERE task_id=?", (task_id,)
            ).fetchone()
        if source_row is not None:
            return {
                "label": row["project_id"],
                "source_kind": source_row["source_kind"],
                "files": inspect_archive_files(source_row["archive"]),
            }
        if row["project_id"] not in catalog:
            return {"label": row["project_id"], "source_kind": "preset", "files": []}
        return {
            "label": row["project_id"],
            "source_kind": "preset",
            "files": inspect_directory_files(projects / row["project_id"]),
        }

    @app.get("/tasks/{task_id}/events", summary="实时订阅任务状态与输出流 (SSE)")
    async def events(task_id: str, request: Request):
        with connect(root) as db:
            task(db, task_id)

        async def event_stream():
            last_marker = None
            while not scheduler.stop.is_set() and not await request.is_disconnected():
                try:
                    with connect(root) as db:
                        row = task(db, task_id)
                except ServiceError:
                    break
                state_data = snapshot(row)
                log_text = row["log"].decode("utf-8", errors="replace")
                truncated = bool(row["truncated"])
                marker = (
                    state_data["status"],
                    state_data["started_at"],
                    state_data["finished_at"],
                    state_data["stop_reason"],
                    state_data["recovery_reason"],
                    len(row["log"]),
                    truncated,
                )
                if marker != last_marker:
                    last_marker = marker
                    payload = json.dumps(
                        {
                            "task": state_data,
                            "logs": {"text": log_text, "truncated": truncated},
                        },
                        ensure_ascii=False,
                    )
                    yield f"data: {payload}\n\n"
                if state_data["finished_at"] is not None:
                    break
                await asyncio.sleep(0.08)

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    @app.post(
        "/tasks/{task_id}/cancel",
        response_model=TaskState,
        summary="取消任务",
        responses={202: {"model": TaskState, "description": "执行器正在停止"}},
    )
    def stop(task_id: str, response: Response):
        data = cancel(root, task_id)
        response.status_code = 202 if data["status"] == "running" else 200
        return data

    @app.get("/tasks/{task_id}/logs", response_model=TaskLogs, summary="读取已收集的日志")
    def logs(task_id: str):
        with connect(root) as db:
            row = task(db, task_id)
            return {
                "text": row["log"].decode("utf-8", errors="replace"),
                "truncated": bool(row["truncated"]),
            }

    @app.get("/tasks/{task_id}/artifacts", response_model=Artifacts, summary="列出产物")
    def artifacts(task_id: str):
        with connect(root) as db:
            if not task(db, task_id)["finished_at"]:
                return {"items": []}
            rows = db.execute(
                """SELECT name,length(content) AS size_bytes FROM artifacts
                                 WHERE task_id=? ORDER BY name""",
                (task_id,),
            )
            return {
                "items": [
                    dict(row, download_url=f"/tasks/{task_id}/artifacts/{row['name']}") for row in rows
                ]
            }

    @app.get("/tasks/{task_id}/artifacts/{name}", summary="下载产物", response_class=Response)
    def download(task_id: str, name: str):
        with connect(root) as db:
            row = db.execute(
                """SELECT content,media_type FROM artifacts JOIN tasks ON tasks.id=artifacts.task_id
                                WHERE tasks.id=? AND name=? AND finished_at IS NOT NULL""",
                (task_id, name),
            ).fetchone()
        if row is None:
            raise ServiceError(404, "artifact_not_found", "产物不存在")
        return Response(
            row["content"],
            media_type=row["media_type"],
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )

    return app
