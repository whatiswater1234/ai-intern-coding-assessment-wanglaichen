import sqlite3
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .models import Artifacts, CreateTask, QueuedTask, TaskLogs, TaskState
from .scheduler import Scheduler
from .storage import ServiceError, cancel, connect, enqueue, snapshot, task


def error_response(status, code, message):
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


class RequestLimits:
    """Cap the actual streamed body before FastAPI parses JSON, including chunked requests."""

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
            if scope["path"].rstrip("/") == "/tasks":
                media = headers.get(b"content-type", b"").partition(b";")[0].strip().lower()
                if media != b"application/json":
                    return await error_response(415, "media_type", "需要 application/json")(
                        scope, receive, send
                    )
                body = bytearray()
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    chunk = message.get("body", b"")
                    if len(body) + len(chunk) > 8192:
                        return await error_response(413, "body_limit", "请求超过 8 KiB")(
                            scope, receive, send
                        )
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

    @app.post("/tasks", status_code=202, response_model=QueuedTask, summary="提交任务")
    def create(body: CreateTask, response: Response):
        if body.project_id not in catalog:
            raise ServiceError(422, "unknown_project", "未知项目，可选：" + "、".join(sorted(catalog)))
        task_id = enqueue(root, body.project_id, body.type, body.timeout_seconds)
        response.headers["Location"] = f"/tasks/{task_id}"
        return {"id": task_id, "status": "queued"}

    @app.get("/tasks/{task_id}", response_model=TaskState, summary="查询状态")
    def status(task_id: str):
        with connect(root) as db:
            return snapshot(task(db, task_id))

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
