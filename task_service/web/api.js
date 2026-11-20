export class ApiRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  let payload = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json();
  }

  if (!response.ok) {
    const code = payload?.error?.code || `http_${response.status}`;
    const message = payload?.error?.message || `请求失败（HTTP ${response.status}）`;
    throw new ApiRequestError(response.status, code, message);
  }

  return { status: response.status, data: payload };
}

export async function fetchCatalog() {
  const { data } = await requestJson("/projects");
  return data;
}

export async function fetchTelemetry() {
  const { data } = await requestJson("/telemetry");
  return data;
}

export async function fetchProjectFiles(projectId) {
  const { data } = await requestJson(`/projects/${encodeURIComponent(projectId)}/files`);
  return data;
}

export async function fetchTaskCollection({ limit = 60, status = null } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set("status", status);
  const { data } = await requestJson(`/tasks?${params.toString()}`);
  return data;
}

export async function createPresetTask({ project_id, type, timeout_seconds }) {
  const { data } = await requestJson("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id, type, timeout_seconds }),
  });
  return data;
}

export async function createInlineTask({ label, files, type, timeout_seconds }) {
  const { data } = await requestJson("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, files, type, timeout_seconds }),
  });
  return data;
}

export async function createArchiveTask({ file, type, timeout_seconds }) {
  const params = new URLSearchParams({
    type,
    timeout_seconds: String(timeout_seconds),
    filename: file.name || "workspace.zip",
  });
  const buffer = await file.arrayBuffer();
  const { data } = await requestJson(`/tasks/archive?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: buffer,
  });
  return data;
}

export async function fetchTaskState(taskId) {
  const { data } = await requestJson(`/tasks/${encodeURIComponent(taskId)}`);
  return data;
}

export async function fetchTaskLogs(taskId) {
  const { data } = await requestJson(`/tasks/${encodeURIComponent(taskId)}/logs`);
  return data;
}

export async function fetchTaskArtifacts(taskId) {
  const { data } = await requestJson(`/tasks/${encodeURIComponent(taskId)}/artifacts`);
  return data;
}

export async function fetchTaskSource(taskId) {
  const { data } = await requestJson(`/tasks/${encodeURIComponent(taskId)}/source`);
  return data;
}

export async function cancelTask(taskId) {
  const { status, data } = await requestJson(`/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
  });
  return { httpStatus: status, task: data };
}

export async function fetchArtifactText(downloadUrl) {
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new ApiRequestError(res.status, "artifact_read_error", "读取产物内容失败");
  }
  const raw = await res.text();
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function openTaskStream(taskId, { onEvent, onClose }) {
  if (typeof window.EventSource === "undefined") {
    return null;
  }
  const es = new EventSource(`/tasks/${encodeURIComponent(taskId)}/events`);
  es.onmessage = (ev) => {
    try {
      const parsed = JSON.parse(ev.data);
      onEvent(parsed);
      if (parsed?.task?.finished_at) {
        es.close();
        onClose?.();
      }
    } catch {
      // Ignore malformed frame
    }
  };
  es.onerror = () => {
    es.close();
    onClose?.();
  };
  return es;
}
