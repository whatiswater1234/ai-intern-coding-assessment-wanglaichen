from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

TaskType = Literal["lint", "test", "build"]


class CreateTask(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    project_id: str = Field(min_length=1, max_length=80, examples=["hello"])
    type: TaskType
    timeout_seconds: int = Field(default=30, ge=1, le=300)


class QueuedTask(BaseModel):
    id: UUID
    status: Literal["queued"]


class ErrorDetail(BaseModel):
    code: str
    message: str


class TaskState(BaseModel):
    id: UUID
    project_id: str
    type: TaskType
    timeout_seconds: int
    status: Literal["queued", "running", "succeeded", "failed", "cancelled", "timeout"]
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    stop_reason: str | None
    recovery_reason: str | None
    exit_code: int | None
    error: ErrorDetail | None


class TaskLogs(BaseModel):
    text: str
    truncated: bool


class Artifact(BaseModel):
    name: str
    size_bytes: int
    download_url: str


class Artifacts(BaseModel):
    items: list[Artifact]
