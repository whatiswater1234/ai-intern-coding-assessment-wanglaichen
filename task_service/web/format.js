export const TERMINAL_STATUSES = new Set(["succeeded", "failed", "timeout", "cancelled"]);

export const SOURCE_KIND_LABELS = {
  preset: "预置仓库",
  inline: "在线改码",
  archive: "ZIP 上传",
};

export const PROJECT_CATALOG_META = {
  hello: {
    tag: "基准模块",
    shortDesc: "问候模块 · 支持构建可执行归档",
    fullDesc:
      "包含问候函数、发布横幅格式化与 4 项通过的单元测试，并提供 __main__.py 入口用于打包生成独立可运行的 app.pyz。",
    ops: ["lint", "test", "build"],
  },
  broken: {
    tag: "断言缺陷",
    shortDesc: "订单计费 · 含故意失败的测试断言",
    fullDesc:
      "模拟购物车小计与优惠券抵扣逻辑：前 2 项测试通过，第 3 项保留 20 != 21 断言错误，用于验证异常捕获与在线改码修复。",
    ops: ["lint", "test"],
  },
  slow: {
    tag: "顽固子进程",
    shortDesc: "12s 分片扫描 · 含忽略 TERM 子进程",
    fullDesc:
      "主进程在独立会话派生忽略 SIGTERM (SIG_IGN) 的后台子进程并逐秒打印进度，用于验证运行中取消与超时看门狗整组强杀回收。",
    ops: ["lint", "test"],
  },
  pipeline: {
    tag: "并发流水线",
    shortDesc: "2.2s 分片校验 · 同名文件隔离自检",
    fullDesc:
      "分 4 阶段模拟 AST 扫描与校验和计算（耗时约 2.2s），并在工作目录读写同名临时文件自检沙箱隔离，专用于双槽并发与排队补位。",
    ops: ["lint", "test"],
  },
  logflood: {
    tag: "日志压测",
    shortDesc: "瞬间输出 96KB · 触发限流排空",
    fullDesc:
      "单次运行连续输出 1,200 行（约 96 KB）追踪日志，用于验证 64 KB 硬上限截断标志与持续非阻塞排空管道防死锁。",
    ops: ["lint", "test"],
  },
};

export function getProjectMeta(project) {
  if (PROJECT_CATALOG_META[project.id]) {
    return PROJECT_CATALOG_META[project.id];
  }
  const ops = ["lint"];
  if (project.has_tests) ops.push("test");
  if (project.has_main) ops.push("build");
  return {
    tag: "预置模块",
    shortDesc: `自定义仓库（${project.file_count || 0} 个文件）`,
    fullDesc: `维护者目录中的预置代码仓库，共包含 ${project.file_count || 0} 个源码文件。`,
    ops,
  };
}

export function visualStatus(task) {
  if (task.status === "running" && task.stop_reason) return "stopping";
  return task.status;
}

export function statusText(task) {
  if (task.status === "running" && task.stop_reason) return "停止中";
  switch (task.status) {
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "succeeded":
      return "成功";
    case "failed":
      return "失败";
    case "timeout":
      return "超时";
    case "cancelled":
      return "已取消";
    default:
      return task.status;
  }
}

export function shortId(id) {
  return String(id || "").slice(0, 8);
}

export function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function diffMs(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function elapsedMs(task, nowMs = Date.now()) {
  if (!task.started_at) return null;
  if (task.finished_at) return diffMs(task.started_at, task.finished_at);
  return Math.max(0, nowMs - new Date(task.started_at).getTime());
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function byteLength(str) {
  if (!str) return 0;
  return new TextEncoder().encode(str).byteLength;
}

export function formatExitCode(task) {
  const rc = task.exit_code;
  if (rc === null || rc === undefined) return "—";
  if (rc === 0) return "0 (正常)";
  if (rc < 0) {
    const sig = Math.abs(rc);
    const name = sig === 15 ? "SIGTERM" : sig === 9 ? "SIGKILL" : `SIG${sig}`;
    return `${rc} (${name})`;
  }
  return `${rc} (异常)`;
}

export function classifyLogLine(line) {
  if (
    line.includes("Traceback (most recent call last)") ||
    line.includes("AssertionError") ||
    line.startsWith("FAIL:") ||
    line.startsWith("ERROR:") ||
    line === "FAILED" ||
    line.startsWith("FAILED (")
  ) {
    return "fail";
  }
  if (line.endsWith("... ok") || line === "OK") {
    return "pass";
  }
  if (
    line.includes("leader=") ||
    line.includes("child_ready=") ||
    line.startsWith("[pid=") ||
    line.startsWith("[step ")
  ) {
    return "info";
  }
  return "normal";
}
