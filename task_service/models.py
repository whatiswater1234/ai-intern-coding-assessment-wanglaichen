from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

TaskType = Literal["lint", "test", "build"]
TaskStatus = Literal["queued", "running", "succeeded", "failed", "cancelled", "timeout"]
SourceKind = Literal["preset", "inline", "archive"]


class CreateTask(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    project_id: str | None = Field(default=None, min_length=1, max_length=80, examples=["hello"])
    files: dict[str, str] | None = Field(default=None)
    label: str | None = Field(default=None, min_length=1, max_length=80)
    type: TaskType
    timeout_seconds: int = Field(default=30, ge=1, le=300)

    @model_validator(mode="after")
    def check_source(self):
        has_project = self.project_id is not None
        has_files = self.files is not None
        if has_project == has_files:
            raise ValueError("须提供 project_id 或 files 其中之一")
        return self


class QueuedTask(BaseModel):
    id: UUID
    status: Literal["queued"]


class ErrorDetail(BaseModel):
    code: str
    message: str


class TaskState(BaseModel):
    id: UUID
    project_id: str
    source_kind: SourceKind = "preset"
    type: TaskType
    timeout_seconds: int
    status: TaskStatus
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


class ProjectInfo(BaseModel):
    id: str
    has_tests: bool
    has_main: bool
    file_count: int = 0


class ServiceCatalog(BaseModel):
    projects: list[ProjectInfo]
    task_types: list[TaskType]
    workers: int
    queue_limit: int
    log_limit_bytes: int
    artifact_limit_bytes: int
    archive_limit_bytes: int


class TaskCollection(BaseModel):
    items: list[TaskState]
    active_tasks: list[TaskState]
    running_count: int
    queued_count: int
    workers: int
    queue_limit: int


class SourceFile(BaseModel):
    path: str
    size_bytes: int
    binary: bool
    content: str


class TaskSource(BaseModel):
    label: str
    source_kind: SourceKind
    files: list[SourceFile]
