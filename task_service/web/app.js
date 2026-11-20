import {
  ApiRequestError,
  cancelTask,
  createArchiveTask,
  createInlineTask,
  createPresetTask,
  fetchArtifactText,
  fetchCatalog,
  fetchProjectFiles,
  fetchTaskArtifacts,
  fetchTaskCollection,
  fetchTaskLogs,
  fetchTaskSource,
  fetchTaskState,
  fetchTelemetry,
  openTaskStream,
} from "/static/api.js";
import { renderFlowchart } from "/static/flowchart.js";
import {
  SOURCE_KIND_LABELS,
  TERMINAL_STATUSES,
  byteLength,
  classifyLogLine,
  elapsedMs,
  formatBytes,
  formatDuration,
  formatExitCode,
  formatTime,
  getProjectMeta,
  shortId,
  statusText,
  visualStatus,
} from "/static/format.js";
import { SCENARIOS, buildScenarioGraph } from "/static/scenarios.js";
import { initTooltips } from "/static/tooltip.js";

const state = {
  catalog: {
    projects: [],
    workers: 2,
    queue_limit: 32,
    log_limit_bytes: 65536,
  },
  telemetry: null,

  dispatch: {
    projectId: "hello",
    type: "test",
    submitting: false,
  },

  activeScenarioId: "concurrency",
  batchTaskIds: [],
  autoCancelArmedForId: null,

  filter: "all",
  tasks: [],
  runningCount: 0,
  queuedCount: 0,
  selectedId: null,
  selectedTask: null,
  selectedLogs: { text: "", truncated: false },
  selectedArtifacts: [],
  selectedSource: { label: "", source_kind: "preset", files: [] },
  activeSourceFile: "",
  subtab: "overview",
  autoFollow: true,
  eventSource: null,

  modal: {
    open: false,
    mode: "inline",
    presetCache: new Map(),
    inlineLabel: "hello-edited",
    inlineFiles: {},
    activeInlineFile: "",
    zipFile: null,
    taskType: "test",
    submitting: false,
  },

  renderedLogKey: "",
  renderedArtifactKey: "",
  pollTimer: null,
  tooltips: null,
};

const dom = {
  onlineBadge: document.getElementById("online-badge"),
  onlineText: document.getElementById("online-text"),
  hostChip: document.getElementById("host-chip"),
  openEditorModalBtn: document.getElementById("open-editor-modal-btn"),
  openZipModalBtn: document.getElementById("open-zip-modal-btn"),

  // Telemetry Cards
  cardWorkers: document.getElementById("card-telemetry-workers"),
  slotUtilTag: document.getElementById("slot-util-tag"),
  slotRatioVal: document.getElementById("slot-ratio-val"),
  workerProcSummary: document.getElementById("worker-proc-summary"),
  slotProgressBar: document.getElementById("slot-progress-bar"),

  cardQueue: document.getElementById("card-telemetry-queue"),
  queueStatusTag: document.getElementById("queue-status-tag"),
  queueRatioVal: document.getElementById("queue-ratio-val"),
  latencySummary: document.getElementById("latency-summary"),
  queueProgressBar: document.getElementById("queue-progress-bar"),

  cardSandbox: document.getElementById("card-telemetry-sandbox"),
  hygieneTag: document.getElementById("hygiene-tag"),
  workspaceCountVal: document.getElementById("workspace-count-val"),
  quarantineSummary: document.getElementById("quarantine-summary"),
  sandboxProgressBar: document.getElementById("sandbox-progress-bar"),

  cardStats: document.getElementById("card-telemetry-stats"),
  storageSizeTag: document.getElementById("storage-size-tag"),
  passRateVal: document.getElementById("pass-rate-val"),
  totalRunsSummary: document.getElementById("total-runs-summary"),
  barSegPass: document.getElementById("bar-seg-pass"),
  barSegFail: document.getElementById("bar-seg-fail"),
  barSegWarn: document.getElementById("bar-seg-warn"),
  barSegCancel: document.getElementById("bar-seg-cancel"),

  // Catalog & Dispatch
  catalogCards: document.getElementById("catalog-cards"),
  directDispatchForm: document.getElementById("direct-dispatch-form"),
  selectedProjBadge: document.getElementById("selected-proj-badge"),
  directTimeoutInput: document.getElementById("direct-timeout-input"),
  directErrorMsg: document.getElementById("direct-error-msg"),
  directSubmitBtn: document.getElementById("direct-submit-btn"),

  // Scenario Lab & Flowchart
  scenarioList: document.getElementById("scenario-list"),
  stageScenNum: document.getElementById("stage-scen-num"),
  stageScenTitle: document.getElementById("stage-scen-title"),
  stageInfoPill: document.getElementById("stage-info-pill"),
  stageTasksUsed: document.getElementById("stage-tasks-used"),
  stageCapabilityShort: document.getElementById("stage-capability-short"),
  scenManualBtn: document.getElementById("scen-manual-btn"),
  scenRunBtn: document.getElementById("scen-run-btn"),
  flowchartBox: document.getElementById("flowchart-box"),
  concurrencyBatchStrip: document.getElementById("concurrency-batch-strip"),
  concurrencyBatchChips: document.getElementById("concurrency-batch-chips"),

  // Cockpit
  liveCockpit: document.getElementById("live-cockpit"),
  historyTotalPill: document.getElementById("history-total-pill"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),

  ssePill: document.getElementById("sse-pill"),
  truncPill: document.getElementById("trunc-pill"),
  logByteCounter: document.getElementById("log-byte-counter"),
  copyLogBtn: document.getElementById("copy-log-btn"),
  logScrollBox: document.getElementById("log-scroll-box"),
  logRows: document.getElementById("log-rows"),

  detailPlaceholder: document.getElementById("detail-placeholder"),
  detailMain: document.getElementById("detail-main"),
  detProject: document.getElementById("det-project"),
  detType: document.getElementById("det-type"),
  detStatus: document.getElementById("det-status"),
  copyUuidBtn: document.getElementById("copy-uuid-btn"),
  detUuid: document.getElementById("det-uuid"),
  detSourceBadge: document.getElementById("det-source-badge"),
  detCancelBtn: document.getElementById("det-cancel-btn"),
  detEditBtn: document.getElementById("det-edit-btn"),
  detRerunBtn: document.getElementById("det-rerun-btn"),

  detArtCnt: document.getElementById("det-art-cnt"),
  detSrcCnt: document.getElementById("det-src-cnt"),
  stabOverview: document.getElementById("stab-overview"),
  stabArtifacts: document.getElementById("stab-artifacts"),
  stabSource: document.getElementById("stab-source"),
  detAlert: document.getElementById("det-alert"),
  detStarted: document.getElementById("det-started"),
  detFinished: document.getElementById("det-finished"),
  detDuration: document.getElementById("det-duration"),
  detExit: document.getElementById("det-exit"),

  artEmpty: document.getElementById("art-empty"),
  artList: document.getElementById("art-list"),
  artJsonBox: document.getElementById("art-json-box"),
  artJsonName: document.getElementById("art-json-name"),
  artJsonPre: document.getElementById("art-json-pre"),
  closeArtJsonBtn: document.getElementById("close-art-json-btn"),
  detSrcTabs: document.getElementById("det-src-tabs"),
  detSrcCode: document.getElementById("det-src-code"),

  // Modal
  studioModal: document.getElementById("studio-modal"),
  closeModalBtn: document.getElementById("close-modal-btn"),
  modalForm: document.getElementById("modal-form"),
  modalInlinePane: document.getElementById("modal-inline-pane"),
  modalArchivePane: document.getElementById("modal-archive-pane"),
  modalLabelInput: document.getElementById("modal-label-input"),
  modalAddFileBtn: document.getElementById("modal-add-file-btn"),
  modalFileTabs: document.getElementById("modal-file-tabs"),
  modalTextarea: document.getElementById("modal-textarea"),
  modalZipDrop: document.getElementById("modal-zip-drop"),
  modalZipInput: document.getElementById("modal-zip-input"),
  modalZipTitle: document.getElementById("modal-zip-title"),
  modalZipSub: document.getElementById("modal-zip-sub"),
  modalError: document.getElementById("modal-error"),
  modalTimeoutInput: document.getElementById("modal-timeout-input"),
  modalSubmitBtn: document.getElementById("modal-submit-btn"),

  toastBox: document.getElementById("toast-box"),
};

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  dom.toastBox.appendChild(el);
  window.setTimeout(() => el.remove(), 2400);
}

async function copyText(str, okMsg) {
  try {
    await navigator.clipboard.writeText(str);
    toast(okMsg);
  } catch {
    toast("不支持写入剪贴板");
  }
}

function renderNumberedLines(container, rawText) {
  container.innerHTML = "";
  const lines = (rawText || "").split("\n");
  const frag = document.createDocumentFragment();
  lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "term-line";
    const ln = document.createElement("span");
    ln.className = "term-ln";
    ln.textContent = String(i + 1);
    const txt = document.createElement("span");
    txt.className = "term-txt";
    txt.textContent = line || " ";
    row.append(ln, txt);
    frag.appendChild(row);
  });
  container.appendChild(frag);
}

/* 第一区：干爽数字监控 + 动态悬停明细 */
function renderTelemetryStrip() {
  const t = state.telemetry;
  if (!t) return;

  dom.onlineBadge.dataset.online = "true";
  dom.onlineText.textContent = "在线";
  dom.hostChip.textContent = `${t.host.cpu_cores} 核 · 负载 ${t.host.load_1m}`;
  dom.hostChip.dataset.tipMeta = `1m 负载 ${t.host.load_1m} · 5m 负载 ${t.host.load_5m} · API RSS ${formatBytes(t.host.api_rss_bytes)}`;

  // Card 1: Workers
  const slotPct = Math.min(100, Math.round((t.slots.running / t.slots.capacity) * 100));
  dom.slotRatioVal.textContent = `${t.slots.running} / ${t.slots.capacity}`;
  dom.slotProgressBar.style.width = `${slotPct}%`;
  dom.slotUtilTag.dataset.tone = t.slots.running > 0 ? "active" : "idle";
  dom.slotUtilTag.textContent = t.slots.running > 0 ? `${slotPct}%` : "空闲";
  dom.workerProcSummary.textContent =
    t.slots.running > 0
      ? `${t.slots.task_processes} 进程 · ${formatBytes(t.slots.task_rss_bytes)}`
      : "待命中";

  if (t.slots.active_workers.length > 0) {
    const lines = t.slots.active_workers.map(
      (w, idx) =>
        `槽#${idx + 1} ${w.project_id}·${w.type} | PGID ${w.pgid || "—"} | ${w.process_count} 进程 · ${formatBytes(w.rss_bytes)} · CPU ${w.cpu_percent}%`
    );
    dom.cardWorkers.dataset.tipMeta = lines.join("\n");
  } else {
    dom.cardWorkers.dataset.tipMeta = "当前 2 个独立执行槽均空闲，无活动子进程组";
  }

  // Card 2: Queue
  const qPct = Math.min(100, Math.round((t.slots.queued / t.slots.queue_limit) * 100));
  dom.queueRatioVal.textContent = `${t.slots.queued} / ${t.slots.queue_limit}`;
  dom.queueProgressBar.style.width = `${qPct}%`;
  dom.queueStatusTag.dataset.tone = t.slots.queued > 0 ? "warn" : "idle";
  dom.queueStatusTag.textContent = t.slots.queued > 0 ? `排队 ${t.slots.queued}` : "畅通";
  dom.latencySummary.textContent = `均排 ${t.metrics.avg_queue_ms}ms`;
  dom.cardQueue.dataset.tipMeta = `平均排队 ${t.metrics.avg_queue_ms} ms · 平均执行 ${(t.metrics.avg_exec_ms / 1000).toFixed(2)}s`;

  // Card 3: Sandbox
  dom.workspaceCountVal.textContent = String(t.sandbox.active_workspaces);
  if (t.sandbox.quarantined_tasks > 0) {
    dom.hygieneTag.dataset.tone = "warn";
    dom.hygieneTag.textContent = `待核查 ${t.sandbox.quarantined_tasks}`;
    dom.quarantineSummary.textContent = "进程核查中";
  } else if (t.sandbox.active_workspaces > 0) {
    dom.hygieneTag.dataset.tone = "active";
    dom.hygieneTag.textContent = `活跃 ${t.sandbox.active_workspaces}`;
    dom.quarantineSummary.textContent = "运行隔离中";
  } else {
    dom.hygieneTag.dataset.tone = "ok";
    dom.hygieneTag.textContent = "✓ 零残留";
    dom.quarantineSummary.textContent = "0700 隔离";
  }

  // Card 4: Stats
  dom.storageSizeTag.textContent = formatBytes(t.metrics.storage_bytes);
  const fin = t.metrics.finished_tasks;
  dom.totalRunsSummary.textContent = `共 ${t.metrics.total_tasks} 次`;
  if (fin > 0) {
    const rate = Math.round((t.metrics.succeeded / fin) * 100);
    dom.passRateVal.textContent = `${rate}%`;
    dom.barSegPass.style.width = `${(t.metrics.succeeded / fin) * 100}%`;
    dom.barSegFail.style.width = `${(t.metrics.failed / fin) * 100}%`;
    dom.barSegWarn.style.width = `${(t.metrics.timeout / fin) * 100}%`;
    dom.barSegCancel.style.width = `${(t.metrics.cancelled / fin) * 100}%`;
  } else {
    dom.passRateVal.textContent = "—";
  }
  dom.cardStats.dataset.tipMeta = `成功 ${t.metrics.succeeded} · 失败 ${t.metrics.failed} · 超时 ${t.metrics.timeout} · 取消 ${t.metrics.cancelled} | SQLite ${formatBytes(t.metrics.storage_bytes)}`;

  state.tooltips?.refreshActive();
}

/* 第二区：极简任务仓库卡片（悬停展示详细说明） */
function sortedProjects() {
  const rank = { hello: 0, broken: 1, slow: 2, pipeline: 3, logflood: 4 };
  return [...state.catalog.projects].sort(
    (a, b) => (rank[a.id] ?? 99) - (rank[b.id] ?? 99) || a.id.localeCompare(b.id)
  );
}

function renderCatalogCards() {
  dom.catalogCards.innerHTML = "";
  const projects = sortedProjects();
  if (projects.length > 0 && !projects.some((p) => p.id === state.dispatch.projectId)) {
    state.dispatch.projectId = projects[0].id;
  }

  for (const proj of projects) {
    const meta = getProjectMeta(proj);
    const card = document.createElement("div");
    card.className = "proj-card";
    card.setAttribute("role", "radio");
    card.tabIndex = 0;
    card.dataset.projectId = proj.id;
    card.setAttribute("aria-checked", String(proj.id === state.dispatch.projectId));

    // Progressive disclosure tooltip on hover!
    card.dataset.tipTitle = `${proj.id} · ${meta.tag}`;
    card.dataset.tipBadge = `${proj.file_count || 0} 个文件`;
    card.dataset.tipBody = meta.fullDesc;
    card.dataset.tipMeta = `支持操作：${meta.ops.join(" / ")}`;

    const upper = document.createElement("div");
    const top = document.createElement("div");
    top.className = "proj-card-top";
    const idBadge = document.createElement("span");
    idBadge.className = "proj-id-badge";
    idBadge.textContent = proj.id;
    const tag = document.createElement("span");
    tag.className = "proj-tag";
    tag.textContent = meta.tag;
    top.append(idBadge, tag);

    const short = document.createElement("p");
    short.className = "proj-short";
    short.textContent = meta.shortDesc;
    upper.append(top, short);

    const foot = document.createElement("div");
    foot.className = "proj-card-foot";
    const ops = document.createElement("div");
    ops.className = "proj-ops";
    for (const op of meta.ops) {
      const opEl = document.createElement("span");
      opEl.className = "op-tag";
      opEl.textContent = op;
      ops.appendChild(opEl);
    }

    const inspectBtn = document.createElement("button");
    inspectBtn.type = "button";
    inspectBtn.className = "inspect-src-btn";
    inspectBtn.textContent = "源码";
    inspectBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openCodeStudioForPreset(proj.id);
    });

    foot.append(ops, inspectBtn);
    card.append(upper, foot);

    const choose = () => {
      state.dispatch.projectId = proj.id;
      if (state.dispatch.type === "build" && !proj.has_main) {
        state.dispatch.type = "test";
      }
      syncDispatchBar();
    };
    card.addEventListener("click", choose);
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        choose();
      }
    });

    dom.catalogCards.appendChild(card);
  }
  syncDispatchBar();
}

function syncDispatchBar() {
  for (const card of dom.catalogCards.querySelectorAll(".proj-card")) {
    card.setAttribute("aria-checked", String(card.dataset.projectId === state.dispatch.projectId));
  }
  dom.selectedProjBadge.textContent = state.dispatch.projectId;
  for (const r of dom.directDispatchForm.querySelectorAll(".pill-radio[data-dtype]")) {
    r.setAttribute("aria-checked", String(r.dataset.dtype === state.dispatch.type));
  }
}

/* 第三区：干爽 6 大能力演示列表 + 动态流程图 */
function renderScenarioList() {
  dom.scenarioList.innerHTML = "";
  for (const scen of SCENARIOS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scen-card";
    btn.setAttribute("role", "tab");
    btn.dataset.scenarioId = scen.id;
    btn.setAttribute("aria-selected", String(scen.id === state.activeScenarioId));

    // Detailed explanation shown only on hover
    btn.dataset.tipTitle = `${scen.num} ${scen.name}`;
    btn.dataset.tipBody = scen.capability;
    btn.dataset.tipMeta = `调用任务：${scen.tasksUsed.join(" + ")}`;

    const row1 = document.createElement("div");
    row1.className = "scen-card-row1";
    const num = document.createElement("span");
    num.className = "scen-badge";
    num.textContent = scen.num;
    const title = document.createElement("span");
    title.className = "scen-card-title";
    title.textContent = scen.name;
    row1.append(num, title);

    const sub = document.createElement("div");
    sub.className = "scen-card-sub";
    const tasksMini = document.createElement("span");
    tasksMini.className = "scen-task-mini";
    tasksMini.textContent = scen.tasksUsed.join(" + ");
    sub.appendChild(tasksMini);

    btn.append(row1, sub);
    btn.addEventListener("click", () => {
      state.activeScenarioId = scen.id;
      syncScenarioStage();
    });
    dom.scenarioList.appendChild(btn);
  }
}

function getBatchTasks() {
  if (state.batchTaskIds.length === 0) return [];
  const map = new Map(state.tasks.map((t) => [t.id, t]));
  return state.batchTaskIds.map((id) => map.get(id)).filter(Boolean);
}

function syncScenarioStage() {
  for (const card of dom.scenarioList.querySelectorAll(".scen-card")) {
    card.setAttribute("aria-selected", String(card.dataset.scenarioId === state.activeScenarioId));
  }
  const scen = SCENARIOS.find((s) => s.id === state.activeScenarioId) || SCENARIOS[0];
  dom.stageScenNum.textContent = scen.num;
  dom.stageScenTitle.textContent = scen.name;
  dom.stageCapabilityShort.textContent = scen.shortCap;
  dom.scenRunBtn.textContent = scen.primaryActionLabel;

  // Put long scenario summary + architecture guarantee into the "ⓘ 原理与预期" hover badge!
  dom.stageInfoPill.dataset.tipTitle = `${scen.num} ${scen.name}`;
  dom.stageInfoPill.dataset.tipBody = `${scen.summary}\n\n底层保证：${scen.designNote}`;
  dom.stageInfoPill.dataset.tipMeta = `测试能力：${scen.capability}`;

  dom.stageTasksUsed.innerHTML = "";
  for (const tName of scen.tasksUsed) {
    const chip = document.createElement("span");
    chip.className = "recipe-chip";
    chip.textContent = tName;
    dom.stageTasksUsed.appendChild(chip);
  }

  if (scen.secondaryActionLabel) {
    dom.scenManualBtn.hidden = false;
    dom.scenManualBtn.textContent = scen.secondaryActionLabel;
  } else {
    dom.scenManualBtn.hidden = true;
  }

  const batchTasks = getBatchTasks();
  dom.concurrencyBatchStrip.hidden = !(state.activeScenarioId === "concurrency" && batchTasks.length > 0);
  if (!dom.concurrencyBatchStrip.hidden) {
    dom.concurrencyBatchChips.innerHTML = "";
    batchTasks.forEach((bt, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "batch-btn";
      b.dataset.active = String(bt.id === state.selectedId);
      b.textContent = `#${idx + 1} ${bt.project_id}·${bt.type} (${statusText(bt)})`;
      b.addEventListener("click", () => selectTask(bt.id));
      dom.concurrencyBatchChips.appendChild(b);
    });
  }

  const graph = buildScenarioGraph(state.activeScenarioId, {
    task: state.selectedTask,
    logs: state.selectedLogs,
    artifacts: state.selectedArtifacts,
    batchTasks,
    queuedCount: state.queuedCount,
  });
  renderFlowchart(dom.flowchartBox, graph);
}

function inferScenario(task) {
  if (!task) return;
  if (state.batchTaskIds.includes(task.id) || task.project_id === "pipeline") {
    state.activeScenarioId = "concurrency";
  } else if (task.project_id === "logflood") {
    state.activeScenarioId = "truncation";
  } else if (task.project_id === "slow") {
    state.activeScenarioId = task.timeout_seconds <= 5 ? "timeout" : "cancel";
  } else if (task.project_id.startsWith("broken")) {
    state.activeScenarioId = "fail";
  } else if (task.type === "build") {
    state.activeScenarioId = "build";
  }
}

/* 第四区：执行队列、终端与详情 */
function filteredHistory() {
  return state.tasks.filter((t) => {
    if (state.filter === "active") return t.status === "queued" || t.status === "running";
    if (state.filter === "succeeded") return t.status === "succeeded";
    if (state.filter === "abnormal") {
      return t.status === "failed" || t.status === "timeout" || t.status === "cancelled";
    }
    return true;
  });
}

function createHistoryItem(task) {
  const li = document.createElement("li");
  li.className = "hist-item";
  li.dataset.taskId = task.id;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hist-btn";

  const dotWrap = document.createElement("span");
  dotWrap.className = "hist-dot-wrap";
  dotWrap.dataset.role = "dot";
  const dot = document.createElement("span");
  dot.className = "hist-dot";
  dotWrap.appendChild(dot);

  const copy = document.createElement("div");
  copy.className = "hist-copy";
  const top = document.createElement("div");
  top.className = "hist-top";
  const name = document.createElement("span");
  name.className = "hist-name";
  name.dataset.role = "name";
  const type = document.createElement("span");
  type.className = "hist-type";
  type.dataset.role = "type";
  top.append(name, type);

  const sub = document.createElement("div");
  sub.className = "hist-sub";
  const st = document.createElement("span");
  st.dataset.role = "st";
  const tm = document.createElement("span");
  tm.dataset.role = "tm";
  sub.append(st, tm);

  copy.append(top, sub);
  btn.append(dotWrap, copy);
  li.appendChild(btn);

  btn.addEventListener("click", () => selectTask(task.id, { inferScenario: true }));
  return li;
}

function updateHistoryItem(li, task, nowMs) {
  li.dataset.selected = String(task.id === state.selectedId);
  li.querySelector('[data-role="dot"]').dataset.status = visualStatus(task);
  li.querySelector('[data-role="name"]').textContent = task.project_id;
  li.querySelector('[data-role="type"]').textContent = task.type;
  const dur = elapsedMs(task, nowMs);
  li.querySelector('[data-role="st"]').textContent =
    dur !== null ? `${statusText(task)} · ${formatDuration(dur)}` : statusText(task);
  li.querySelector('[data-role="tm"]').textContent = formatTime(task.created_at);
}

function renderHistoryList(nowMs = Date.now()) {
  dom.historyTotalPill.textContent = String(state.tasks.length);
  const items = filteredHistory();
  dom.historyEmpty.hidden = items.length > 0;

  const existing = new Map();
  for (const node of dom.historyList.children) {
    existing.set(node.dataset.taskId, node);
  }
  const keep = new Set(items.map((t) => t.id));
  for (const [id, node] of existing.entries()) {
    if (!keep.has(id)) {
      node.remove();
      existing.delete(id);
    }
  }

  items.forEach((task, idx) => {
    let row = existing.get(task.id);
    if (!row) {
      row = createHistoryItem(task);
      existing.set(task.id, row);
    }
    updateHistoryItem(row, task, nowMs);
    const cur = dom.historyList.children[idx];
    if (cur !== row) dom.historyList.insertBefore(row, cur || null);
  });
}

function renderConsoleLogs() {
  const task = state.selectedTask;
  if (!task) {
    dom.logByteCounter.textContent = "0 B / 64 KB";
    dom.truncPill.hidden = true;
    dom.logRows.innerHTML = '<div class="term-placeholder">等待选择或运行任务…</div>';
    return;
  }

  const { text, truncated } = state.selectedLogs;
  const bytes = byteLength(text);
  const limit = state.catalog.log_limit_bytes || 65536;
  dom.logByteCounter.textContent = `${formatBytes(bytes)} / ${formatBytes(limit)}`;
  dom.truncPill.hidden = !truncated;

  const key = `${task.id}:${text.length}:${truncated}:${task.status}`;
  if (key === state.renderedLogKey) return;
  state.renderedLogKey = key;

  dom.logRows.innerHTML = "";
  if (!text) {
    const empty = document.createElement("div");
    empty.className = "term-placeholder";
    if (task.status === "queued") {
      empty.textContent = "排队等待空闲 Worker…";
    } else if (task.status === "running") {
      empty.textContent = "进程组运行中，等待输出…";
    } else if (task.status === "succeeded" && task.type === "build") {
      empty.textContent = "构建成功 (rc=0)，可在右侧「产物」下载 app.pyz。";
    } else if (task.status === "succeeded" && task.type === "lint") {
      empty.textContent = "语法检查通过 (rc=0，无错误输出)。";
    } else {
      empty.textContent = "无输出内容。";
    }
    dom.logRows.appendChild(empty);
    return;
  }

  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const frag = document.createDocumentFragment();
  lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "term-line";
    row.dataset.kind = classifyLogLine(line);
    const ln = document.createElement("span");
    ln.className = "term-ln";
    ln.textContent = String(i + 1);
    const txt = document.createElement("span");
    txt.className = "term-txt";
    txt.textContent = line || " ";
    row.append(ln, txt);
    frag.appendChild(row);
  });
  dom.logRows.appendChild(frag);

  if (state.autoFollow) {
    dom.logScrollBox.scrollTop = dom.logScrollBox.scrollHeight;
  }
}

function setSubtab(key) {
  state.subtab = key;
  for (const b of document.querySelectorAll(".s-tab[data-stab]")) {
    b.setAttribute("aria-selected", String(b.dataset.stab === key));
  }
  dom.stabOverview.hidden = key !== "overview";
  dom.stabArtifacts.hidden = key !== "artifacts";
  dom.stabSource.hidden = key !== "source";
}

function renderDetailPane(nowMs = Date.now()) {
  const task = state.selectedTask;
  if (!task) {
    dom.detailPlaceholder.hidden = false;
    dom.detailMain.hidden = true;
    return;
  }

  dom.detailPlaceholder.hidden = true;
  dom.detailMain.hidden = false;

  const vKey = visualStatus(task);
  dom.detProject.textContent = task.project_id;
  dom.detType.textContent = task.type;
  dom.detStatus.dataset.status = vKey;
  dom.detStatus.textContent = statusText(task);
  dom.detUuid.textContent = shortId(task.id);
  dom.detSourceBadge.textContent = SOURCE_KIND_LABELS[task.source_kind] || "预置仓库";

  const active = task.status === "queued" || task.status === "running";
  dom.detCancelBtn.hidden = !active;
  dom.detEditBtn.hidden = active;
  dom.detRerunBtn.hidden = active;
  if (active) {
    const stopping = task.status === "running" && Boolean(task.stop_reason);
    dom.detCancelBtn.disabled = stopping;
    dom.detCancelBtn.textContent = stopping ? "停止中" : "取消";
  }

  dom.detStarted.textContent = task.started_at ? formatTime(task.started_at) : "排队中";
  dom.detFinished.textContent = task.finished_at
    ? formatTime(task.finished_at)
    : task.status === "running"
      ? "运行中…"
      : "—";
  const dur = elapsedMs(task, nowMs);
  dom.detDuration.textContent =
    dur !== null ? `${formatDuration(dur)} / ${task.timeout_seconds}s` : `限时 ${task.timeout_seconds}s`;
  dom.detExit.textContent = formatExitCode(task);

  if (task.recovery_reason) {
    dom.detAlert.hidden = false;
    dom.detAlert.dataset.tone = "warn";
    dom.detAlert.textContent = "正在核查进程组并清理沙箱…";
  } else if (task.error) {
    dom.detAlert.hidden = false;
    dom.detAlert.dataset.tone =
      task.status === "timeout" ? "warn" : task.status === "cancelled" ? "neutral" : "error";
    dom.detAlert.textContent = task.error.message;
  } else {
    dom.detAlert.hidden = true;
  }
}

function renderDetailArtifacts() {
  const task = state.selectedTask;
  if (!task) return;
  const items = state.selectedArtifacts;
  dom.detArtCnt.textContent = String(items.length);

  const key = `${task.id}:${task.status}:${items.map((a) => `${a.name}:${a.size_bytes}`).join(",")}`;
  if (key === state.renderedArtifactKey) return;
  state.renderedArtifactKey = key;

  dom.artJsonBox.hidden = true;
  if (items.length === 0) {
    dom.artEmpty.hidden = false;
    dom.artList.hidden = true;
    dom.artEmpty.textContent = !TERMINAL_STATUSES.has(task.status) ? "终态发布后开放下载" : "本次无产物";
    return;
  }

  dom.artEmpty.hidden = true;
  dom.artList.hidden = false;
  dom.artList.innerHTML = "";

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "art-row";

    const info = document.createElement("div");
    const name = document.createElement("span");
    name.className = "art-name";
    name.textContent = item.name;
    const sub = document.createElement("span");
    sub.className = "art-sub";
    sub.textContent = formatBytes(item.size_bytes);
    info.append(name, sub);

    const btns = document.createElement("div");
    btns.className = "art-btns";
    if (item.name.endsWith(".json")) {
      const pBtn = document.createElement("button");
      pBtn.type = "button";
      pBtn.className = "sm-btn sm-btn--ghost";
      pBtn.textContent = "预览";
      pBtn.addEventListener("click", async () => {
        try {
          dom.artJsonName.textContent = item.name;
          dom.artJsonPre.textContent = await fetchArtifactText(item.download_url);
          dom.artJsonBox.hidden = false;
        } catch (err) {
          toast(err.message || "读取失败");
        }
      });
      btns.appendChild(pBtn);
    }

    const dl = document.createElement("a");
    dl.className = "dl-link";
    dl.href = item.download_url;
    dl.download = item.name;
    dl.textContent = "下载";
    btns.appendChild(dl);

    row.append(info, btns);
    dom.artList.appendChild(row);
  }
}

function renderDetailSource() {
  const files = state.selectedSource.files || [];
  dom.detSrcCnt.textContent = String(files.length);
  dom.detSrcTabs.innerHTML = "";
  if (files.length === 0) {
    renderNumberedLines(dom.detSrcCode, "# 暂无源码");
    return;
  }
  if (!files.some((f) => f.path === state.activeSourceFile)) {
    const pref = files.find((f) => f.path.includes("test_")) || files[0];
    state.activeSourceFile = pref.path;
  }
  for (const f of files) {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "code-tab";
    t.setAttribute("aria-selected", String(f.path === state.activeSourceFile));
    t.textContent = f.path;
    t.addEventListener("click", () => {
      state.activeSourceFile = f.path;
      renderDetailSource();
    });
    dom.detSrcTabs.appendChild(t);
  }
  const cur = files.find((f) => f.path === state.activeSourceFile) || files[0];
  renderNumberedLines(dom.detSrcCode, cur.binary ? "# 二进制文件" : cur.content);
}

/* SSE 与自动取消 */
function closeStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  dom.ssePill.hidden = true;
}

async function checkAutoCancel(task, logs) {
  if (
    state.autoCancelArmedForId === task.id &&
    task.status === "running" &&
    !task.stop_reason &&
    (logs?.text || "").includes("child_ready=")
  ) {
    state.autoCancelArmedForId = null;
    window.setTimeout(async () => {
      try {
        await cancelTask(task.id);
        toast("已自动发送取消请求，回收整棵进程组");
        await refreshAll();
      } catch {
        // done
      }
    }, 800);
  }
}

function attachStream(task) {
  if (!task || TERMINAL_STATUSES.has(task.status)) {
    closeStream();
    return;
  }
  if (state.eventSource) return;

  state.eventSource = openTaskStream(task.id, {
    onEvent: async (frame) => {
      if (state.selectedId !== task.id) return;
      dom.ssePill.hidden = false;
      state.selectedTask = frame.task;
      state.selectedLogs = frame.logs;

      const idx = state.tasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) state.tasks[idx] = frame.task;

      await checkAutoCancel(frame.task, frame.logs);

      renderHistoryList();
      syncScenarioStage();
      renderConsoleLogs();
      renderDetailPane();

      if (frame.task.finished_at) {
        closeStream();
        await refreshAll();
      }
    },
    onClose: () => {
      state.eventSource = null;
      dom.ssePill.hidden = true;
    },
  });
}

async function syncSelectedTask(taskId, { withSource = false } = {}) {
  if (!taskId) return;
  try {
    const [task, logs] = await Promise.all([fetchTaskState(taskId), fetchTaskLogs(taskId)]);
    if (state.selectedId !== taskId) return;
    state.selectedTask = task;
    state.selectedLogs = logs;
    await checkAutoCancel(task, logs);

    const idx = state.tasks.findIndex((t) => t.id === taskId);
    if (idx !== -1) state.tasks[idx] = task;

    if (task.finished_at) {
      const arts = await fetchTaskArtifacts(taskId);
      if (state.selectedId === taskId) {
        state.selectedArtifacts = arts.items || [];
      }
      if (task.type === "build" && task.status === "succeeded" && state.subtab === "overview") {
        setSubtab("artifacts");
      }
    } else {
      state.selectedArtifacts = [];
    }

    if (withSource) {
      try {
        state.selectedSource = await fetchTaskSource(taskId);
      } catch {
        state.selectedSource = { label: task.project_id, source_kind: "preset", files: [] };
      }
    }

    renderHistoryList();
    syncScenarioStage();
    renderConsoleLogs();
    renderDetailPane();
    renderDetailArtifacts();
    if (withSource) renderDetailSource();
    attachStream(task);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) {
      state.selectedId = null;
      state.selectedTask = null;
      await refreshAll();
    }
  }
}

async function selectTask(taskId, { inferScenario: shouldInfer = false } = {}) {
  if (!taskId) return;
  if (state.selectedId !== taskId) {
    closeStream();
    state.selectedId = taskId;
    state.autoFollow = true;
    state.selectedArtifacts = [];
    state.activeSourceFile = "";
    setSubtab("overview");
  }
  const cached = state.tasks.find((t) => t.id === taskId);
  if (cached) {
    state.selectedTask = cached;
    if (shouldInfer) inferScenario(cached);
  }
  renderHistoryList();
  syncScenarioStage();
  renderDetailPane();
  await syncSelectedTask(taskId, { withSource: true });
  schedulePoll();
}

async function refreshAll() {
  try {
    const [col, telem] = await Promise.all([fetchTaskCollection({ limit: 60 }), fetchTelemetry()]);
    state.tasks = col.items || [];
    state.runningCount = col.running_count || 0;
    state.queuedCount = col.queued_count || 0;
    state.telemetry = telem;

    if (!state.selectedId && state.tasks.length > 0) {
      state.selectedId = state.tasks[0].id;
      await syncSelectedTask(state.selectedId, { withSource: true });
    } else if (state.selectedId && !state.eventSource) {
      await syncSelectedTask(state.selectedId, { withSource: false });
    }

    renderTelemetryStrip();
    renderHistoryList();
    syncScenarioStage();
  } catch {
    dom.onlineBadge.dataset.online = "false";
    dom.onlineText.textContent = "离线";
  }
}

function schedulePoll() {
  window.clearTimeout(state.pollTimer);
  if (document.hidden) return;
  const busy =
    state.runningCount > 0 ||
    state.queuedCount > 0 ||
    (state.selectedTask && !TERMINAL_STATUSES.has(state.selectedTask.status));
  state.pollTimer = window.setTimeout(async () => {
    await refreshAll();
    schedulePoll();
  }, busy ? 350 : 2500);
}

/* 6 大演示触发 */
async function runScenarioDemo(scenarioId, { autoCancel = true } = {}) {
  dom.scenRunBtn.disabled = true;
  try {
    if (scenarioId === "build") {
      const c = await createPresetTask({ project_id: "hello", type: "build", timeout_seconds: 30 });
      await refreshAll();
      await selectTask(c.id);
      toast("已启动构建归档演示");
    } else if (scenarioId === "fail") {
      const c = await createPresetTask({ project_id: "broken", type: "test", timeout_seconds: 30 });
      await refreshAll();
      await selectTask(c.id);
      toast("已启动失败断言演示");
    } else if (scenarioId === "cancel") {
      const c = await createPresetTask({ project_id: "slow", type: "test", timeout_seconds: 30 });
      state.autoCancelArmedForId = autoCancel ? c.id : null;
      await refreshAll();
      await selectTask(c.id);
      toast(autoCancel ? "已启动：就绪后将自动取消" : "已启动：可在下方手动取消");
    } else if (scenarioId === "timeout") {
      const c = await createPresetTask({ project_id: "slow", type: "test", timeout_seconds: 2 });
      await refreshAll();
      await selectTask(c.id);
      toast("已启动 2s 超时看门狗演示");
    } else if (scenarioId === "concurrency") {
      const [t1, t2] = await Promise.all([
        createPresetTask({ project_id: "pipeline", type: "test", timeout_seconds: 30 }),
        createPresetTask({ project_id: "pipeline", type: "test", timeout_seconds: 30 }),
      ]);
      const [t3, t4] = await Promise.all([
        createPresetTask({ project_id: "hello", type: "lint", timeout_seconds: 30 }),
        createPresetTask({ project_id: "hello", type: "build", timeout_seconds: 30 }),
      ]);
      state.batchTaskIds = [t1.id, t2.id, t3.id, t4.id];
      await refreshAll();
      await selectTask(t1.id);
      toast("已并发提交 4 个任务");
    } else if (scenarioId === "truncation") {
      const c = await createPresetTask({ project_id: "logflood", type: "test", timeout_seconds: 30 });
      await refreshAll();
      await selectTask(c.id);
      toast("已启动 64KB 日志限流演示");
    }
  } catch (err) {
    toast(err.message || "启动失败");
  } finally {
    dom.scenRunBtn.disabled = false;
  }
}

/* 模态框：在线改码 & ZIP 上传 */
async function getCachedPresetFiles(projectId) {
  if (state.modal.presetCache.has(projectId)) {
    return state.modal.presetCache.get(projectId);
  }
  const res = await fetchProjectFiles(projectId);
  state.modal.presetCache.set(projectId, res.files || []);
  return res.files || [];
}

function setModalMode(mode) {
  state.modal.mode = mode;
  for (const p of dom.studioModal.querySelectorAll(".m-pill[data-modal-mode]")) {
    p.setAttribute("aria-selected", String(p.dataset.modalMode === mode));
  }
  dom.modalInlinePane.hidden = mode !== "inline";
  dom.modalArchivePane.hidden = mode !== "archive";
}

function renderModalEditorTabs() {
  dom.modalFileTabs.innerHTML = "";
  const paths = Object.keys(state.modal.inlineFiles);
  if (paths.length === 0) return;
  if (!state.modal.activeInlineFile || !(state.modal.activeInlineFile in state.modal.inlineFiles)) {
    state.modal.activeInlineFile = paths.find((p) => p.includes("test_")) || paths[0];
  }
  for (const path of paths) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "code-tab";
    b.setAttribute("aria-selected", String(path === state.modal.activeInlineFile));
    b.textContent = path;
    b.addEventListener("click", () => {
      state.modal.activeInlineFile = path;
      renderModalEditorTabs();
    });
    dom.modalFileTabs.appendChild(b);
  }
  dom.modalTextarea.value = state.modal.inlineFiles[state.modal.activeInlineFile] ?? "";
}

async function openCodeStudioForPreset(projectId, sourceList = null, defaultType = "test") {
  try {
    const list = sourceList || (await getCachedPresetFiles(projectId));
    const map = {};
    for (const f of list) {
      if (!f.binary) map[f.path] = f.content;
    }
    state.modal.inlineFiles = map;
    state.modal.activeInlineFile = "";
    const label = projectId.endsWith("-edited") ? projectId : `${projectId}-edited`;
    state.modal.inlineLabel = label;
    dom.modalLabelInput.value = label;
    state.modal.taskType = defaultType;
    syncModalTypeRadios();
    setModalMode("inline");
    renderModalEditorTabs();
    dom.modalError.hidden = true;
    dom.studioModal.hidden = false;
    state.modal.open = true;
  } catch (err) {
    toast(err.message || "读取源码失败");
  }
}

function openZipModal() {
  setModalMode("archive");
  dom.modalError.hidden = true;
  dom.studioModal.hidden = false;
  state.modal.open = true;
}

function closeModal() {
  dom.studioModal.hidden = true;
  state.modal.open = false;
}

function syncModalTypeRadios() {
  for (const b of document.querySelectorAll("#modal-type-radios .pill-radio[data-mtype]")) {
    b.setAttribute("aria-checked", String(b.dataset.mtype === state.modal.taskType));
  }
}

function bindEvents() {
  for (const r of dom.directDispatchForm.querySelectorAll(".pill-radio[data-dtype]")) {
    r.addEventListener("click", () => {
      state.dispatch.type = r.dataset.dtype;
      syncDispatchBar();
    });
  }

  dom.directDispatchForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (state.dispatch.submitting) return;
    dom.directErrorMsg.hidden = true;

    const timeout = Number(dom.directTimeoutInput.value.trim());
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
      dom.directErrorMsg.hidden = false;
      dom.directErrorMsg.textContent = "限时须为 1–300 秒";
      return;
    }

    state.dispatch.submitting = true;
    dom.directSubmitBtn.disabled = true;
    try {
      const created = await createPresetTask({
        project_id: state.dispatch.projectId,
        type: state.dispatch.type,
        timeout_seconds: timeout,
      });
      await refreshAll();
      await selectTask(created.id, { inferScenario: true });
      dom.liveCockpit.scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast(`已提交 ${state.dispatch.projectId} · ${state.dispatch.type}`);
    } catch (err) {
      dom.directErrorMsg.hidden = false;
      dom.directErrorMsg.textContent = err.message || "提交失败";
    } finally {
      state.dispatch.submitting = false;
      dom.directSubmitBtn.disabled = false;
    }
  });

  dom.scenRunBtn.addEventListener("click", () => {
    runScenarioDemo(state.activeScenarioId, { autoCancel: true });
  });
  dom.scenManualBtn.addEventListener("click", () => {
    runScenarioDemo(state.activeScenarioId, { autoCancel: false });
  });

  for (const f of document.querySelectorAll(".f-tab[data-filter]")) {
    f.addEventListener("click", () => {
      state.filter = f.dataset.filter;
      for (const tab of document.querySelectorAll(".f-tab[data-filter]")) {
        tab.setAttribute("aria-selected", String(tab.dataset.filter === state.filter));
      }
      renderHistoryList();
    });
  }

  for (const s of document.querySelectorAll(".s-tab[data-stab]")) {
    s.addEventListener("click", () => setSubtab(s.dataset.stab));
  }

  dom.copyLogBtn.addEventListener("click", () => {
    copyText(state.selectedLogs.text || "", "已复制日志");
  });

  dom.logScrollBox.addEventListener("scroll", () => {
    const nearBottom =
      dom.logScrollBox.scrollHeight - dom.logScrollBox.scrollTop - dom.logScrollBox.clientHeight < 36;
    state.autoFollow = nearBottom;
  });

  dom.copyUuidBtn.addEventListener("click", () => {
    if (state.selectedTask) copyText(state.selectedTask.id, "已复制任务 UUID");
  });

  dom.closeArtJsonBtn.addEventListener("click", () => {
    dom.artJsonBox.hidden = true;
  });

  dom.detCancelBtn.addEventListener("click", async () => {
    if (!state.selectedTask) return;
    state.autoCancelArmedForId = null;
    try {
      await cancelTask(state.selectedTask.id);
      toast("已发送取消请求");
      await refreshAll();
    } catch (err) {
      toast(err.message || "取消失败");
    }
  });

  dom.detRerunBtn.addEventListener("click", async () => {
    const t = state.selectedTask;
    if (!t) return;
    try {
      let created;
      if (t.source_kind === "preset") {
        created = await createPresetTask({
          project_id: t.project_id,
          type: t.type,
          timeout_seconds: t.timeout_seconds,
        });
      } else {
        const files = {};
        for (const f of state.selectedSource.files || []) {
          if (!f.binary) files[f.path] = f.content;
        }
        created = await createInlineTask({
          label: t.project_id,
          files,
          type: t.type,
          timeout_seconds: t.timeout_seconds,
        });
      }
      await refreshAll();
      await selectTask(created.id);
      toast("已重新提交");
    } catch (err) {
      toast(err.message || "重跑失败");
    }
  });

  dom.detEditBtn.addEventListener("click", () => {
    const t = state.selectedTask;
    if (!t) return;
    openCodeStudioForPreset(t.project_id, state.selectedSource.files, t.type);
  });

  dom.openEditorModalBtn.addEventListener("click", () => {
    openCodeStudioForPreset(state.dispatch.projectId, null, state.dispatch.type);
  });
  dom.openZipModalBtn.addEventListener("click", openZipModal);
  dom.closeModalBtn.addEventListener("click", closeModal);
  dom.studioModal.addEventListener("click", (ev) => {
    if (ev.target === dom.studioModal) closeModal();
  });

  for (const p of dom.studioModal.querySelectorAll(".m-pill[data-modal-mode]")) {
    p.addEventListener("click", async () => {
      if (p.dataset.modalMode === "inline" && Object.keys(state.modal.inlineFiles).length === 0) {
        await openCodeStudioForPreset(state.dispatch.projectId);
      } else {
        setModalMode(p.dataset.modalMode);
      }
    });
  }

  for (const r of document.querySelectorAll("#modal-type-radios .pill-radio[data-mtype]")) {
    r.addEventListener("click", () => {
      state.modal.taskType = r.dataset.mtype;
      syncModalTypeRadios();
    });
  }

  dom.modalTextarea.addEventListener("input", () => {
    if (state.modal.activeInlineFile) {
      state.modal.inlineFiles[state.modal.activeInlineFile] = dom.modalTextarea.value;
    }
  });

  dom.modalTextarea.addEventListener("keydown", (ev) => {
    if (ev.key === "Tab") {
      ev.preventDefault();
      const s = dom.modalTextarea.selectionStart;
      const e = dom.modalTextarea.selectionEnd;
      const v = dom.modalTextarea.value;
      dom.modalTextarea.value = `${v.slice(0, s)}    ${v.slice(e)}`;
      dom.modalTextarea.selectionStart = dom.modalTextarea.selectionEnd = s + 4;
      if (state.modal.activeInlineFile) {
        state.modal.inlineFiles[state.modal.activeInlineFile] = dom.modalTextarea.value;
      }
    }
  });

  dom.modalAddFileBtn.addEventListener("click", () => {
    const raw = window.prompt("输入新文件相对路径（如 helper.py）：", "helper.py");
    if (!raw) return;
    const clean = raw.trim().replace(/^\/+/, "");
    if (!clean) return;
    if (!(clean in state.modal.inlineFiles)) {
      state.modal.inlineFiles[clean] = "";
    }
    state.modal.activeInlineFile = clean;
    renderModalEditorTabs();
  });

  const setModalZip = (file) => {
    if (!file) return;
    state.modal.zipFile = file;
    dom.modalZipTitle.textContent = `已选择：${file.name}（${formatBytes(file.size)}）`;
    dom.modalZipSub.textContent = "点击右下角按钮即可上传并在隔离沙箱运行";
  };

  dom.modalZipInput.addEventListener("change", () => {
    if (dom.modalZipInput.files?.[0]) setModalZip(dom.modalZipInput.files[0]);
  });
  dom.modalZipDrop.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    dom.modalZipDrop.dataset.dragover = "true";
  });
  dom.modalZipDrop.addEventListener("dragleave", () => {
    dom.modalZipDrop.dataset.dragover = "false";
  });
  dom.modalZipDrop.addEventListener("drop", (ev) => {
    ev.preventDefault();
    dom.modalZipDrop.dataset.dragover = "false";
    if (ev.dataTransfer?.files?.[0]) setModalZip(ev.dataTransfer.files[0]);
  });

  dom.modalForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (state.modal.submitting) return;
    dom.modalError.hidden = true;

    const timeout = Number(dom.modalTimeoutInput.value.trim());
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
      dom.modalError.hidden = false;
      dom.modalError.textContent = "限时须为 1–300 整数秒";
      return;
    }

    state.modal.submitting = true;
    dom.modalSubmitBtn.disabled = true;
    try {
      let created;
      if (state.modal.mode === "inline") {
        created = await createInlineTask({
          label: dom.modalLabelInput.value.trim() || "custom-workspace",
          files: state.modal.inlineFiles,
          type: state.modal.taskType,
          timeout_seconds: timeout,
        });
      } else {
        if (!state.modal.zipFile) {
          dom.modalError.hidden = false;
          dom.modalError.textContent = "请先选择 .zip 压缩包";
          return;
        }
        created = await createArchiveTask({
          file: state.modal.zipFile,
          type: state.modal.taskType,
          timeout_seconds: timeout,
        });
      }
      closeModal();
      await refreshAll();
      await selectTask(created.id, { inferScenario: true });
      dom.liveCockpit.scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast("扩展代码任务已提交");
    } catch (err) {
      dom.modalError.hidden = false;
      dom.modalError.textContent = err.message || "提交失败";
    } finally {
      state.modal.submitting = false;
      dom.modalSubmitBtn.disabled = false;
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && state.modal.open) {
      closeModal();
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter" && state.modal.open) {
      ev.preventDefault();
      dom.modalForm.requestSubmit();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAll().then(schedulePoll);
  });

  window.setInterval(() => {
    if (state.runningCount > 0 || (state.selectedTask && state.selectedTask.status === "running")) {
      const nowMs = Date.now();
      renderHistoryList(nowMs);
      renderDetailPane(nowMs);
      syncScenarioStage();
    }
  }, 150);
}

async function init() {
  state.tooltips = initTooltips();
  bindEvents();
  renderScenarioList();
  try {
    state.catalog = await fetchCatalog();
  } catch {
    // retry on refresh
  }
  renderCatalogCards();
  await refreshAll();
  syncScenarioStage();
  schedulePoll();
}

init();
