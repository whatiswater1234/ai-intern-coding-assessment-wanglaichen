import { elapsedMs, formatBytes, formatDuration, statusText } from "/static/format.js";

export const SCENARIOS = [
  {
    id: "build",
    num: "01",
    name: "构建与原子产物发布",
    tasksUsed: ["hello · build"],
    shortCap: "隔离打包 · 删目录后下载",
    capability: "验证 0700 临时目录隔离构建、两阶段暂存及临时目录清理后仍可下载运行产物",
    summary:
      "在私有沙箱复制 hello 并执行 zipapp 打包；先将 app.pyz 与报告写入 SQLite 暂存，确认 work/<id> 目录删除后才公开终态与下载链接。",
    designNote: "产物持久化在 SQLite artifacts 表中，终态发布前下载列表严格为空。",
    primaryActionLabel: "▶ 运行演示",
  },
  {
    id: "fail",
    num: "02",
    name: "失败断言与改码修复",
    tasksUsed: ["broken · test"],
    shortCap: "stderr 捕获 · rc=1 判定",
    capability: "验证 stdout/stderr 合并收集、非零退出码 rc=1 精确判定及在线改码重跑闭环",
    summary:
      "运行计费模块 3 项测试：前 2 项通过，第 3 项触发 20 != 21 断言异常；完整记录 Traceback 并可在下方点「改码重跑」修复变绿。",
    designNote: "业务命令失败查询仍返回 HTTP 200，结构化错误码 nonzero_exit 同步写入报告。",
    primaryActionLabel: "▶ 运行演示",
  },
  {
    id: "cancel",
    num: "03",
    name: "运行中取消与进程组回收",
    tasksUsed: ["slow · test", "POST /cancel"],
    shortCap: "killpg 分级强杀顽固子进程",
    capability: "验证独立会话进程组隔离及忽略 SIGTERM 后台子进程的分级信号强杀清理",
    summary:
      "启动 slow 派生忽略 SIGTERM 的子进程；实时流捕获 child_ready 后自动触发取消，验证向整个 PGID 发送 SIGTERM → SIGKILL 彻底回收。",
    designNote: "组长进程在发完组信号前保持未 wait 状态以锁定 PGID，配合 ps 核验确保零孤儿进程。",
    primaryActionLabel: "▶ 自动取消演示",
    secondaryActionLabel: "手动取消",
  },
  {
    id: "timeout",
    num: "04",
    name: "单调时钟超时看门狗",
    tasksUsed: ["slow · test (2s)"],
    shortCap: "kqueue · 2.0s 到期中断",
    capability: "验证 kqueue 事件循环与 monotonic 单调时钟截止点自动强杀超时任务",
    summary:
      "对 12 秒慢任务设定 2 秒上限：到达 2.0s 单调时钟期限立即登记 timeout 并强杀整棵进程树，排队耗时不计入执行限时。",
    designNote: "独立 runner 持有截止时间，即使 API 重启期间也能按时终止超时任务。",
    primaryActionLabel: "▶ 运行 2s 超时",
  },
  {
    id: "concurrency",
    num: "05",
    name: "双槽并发与队列自动补位",
    tasksUsed: ["pipeline·test ×2", "hello·lint", "hello·build"],
    shortCap: "2 Workers 隔离 · FIFO 补位",
    capability: "验证最大并发数 (2 Workers) 控制、同名文件沙箱互不污染及 FIFO 队列自动补位",
    summary:
      "同时派发 4 个任务：前 2 个 2.2s 流水线占满双槽并各自读写同名临时文件自检隔离；后 2 个进入队列候补，槽位释放瞬间自动补位完成。",
    designNote: "容量检查与序号分配在同一 IMMEDIATE 写事务完成；每槽独占 flock 与私有 TMPDIR。",
    primaryActionLabel: "▶ 发起 4 任务并发",
  },
  {
    id: "truncation",
    num: "06",
    name: "64KB 日志限流与排空",
    tasksUsed: ["logflood · test"],
    shortCap: "64KB 截断 · 管道防死锁",
    capability: "验证单任务 64 KiB 日志硬上限、截断标志触发及管道持续排空防阻塞",
    summary:
      "输出 96 KB 追踪日志：仅前 65,536 字节写入数据库并置 truncated=true，同时继续读取丢弃后续 32 KB 输出防止子进程写阻塞挂起。",
    designNote: "持续非阻塞排空 OS 管道缓冲区，确保高频输出任务正常退出 rc=0。",
    primaryActionLabel: "▶ 运行限流演示",
  },
];

function singleLifecycleStages(task) {
  if (!task) return { queued: "idle", prep: "idle", exec: "idle", clean: "idle", pub: "idle" };
  if (task.status === "queued") {
    return { queued: "done", prep: "active", exec: "idle", clean: "idle", pub: "idle" };
  }
  if (task.status === "running") {
    const stopping = Boolean(task.stop_reason);
    return {
      queued: "done",
      prep: "done",
      exec: stopping ? "warn" : "active",
      clean: stopping ? "active" : "idle",
      pub: "idle",
    };
  }
  const pubTone =
    task.status === "succeeded"
      ? "done"
      : task.status === "failed"
        ? "error"
        : task.status === "timeout"
          ? "warn"
          : "warn";
  return {
    queued: "done",
    prep: "done",
    exec: task.status === "succeeded" ? "done" : pubTone,
    clean: "done",
    pub: pubTone,
  };
}

export function buildScenarioGraph(scenarioId, { task, logs, artifacts, batchTasks, queuedCount }) {
  const nowMs = Date.now();
  const dur = task ? elapsedMs(task, nowMs) : null;
  const durLabel = dur !== null ? formatDuration(dur) : "待启动";

  if (scenarioId === "build") {
    const st = singleLifecycleStages(task);
    const hasPyz = (artifacts || []).some((a) => a.name === "app.pyz");
    return {
      viewBox: "0 0 920 150",
      nodes: [
        { id: "n1", x: 16, y: 46, w: 154, h: 58, tone: st.queued, title: "POST /tasks", sub: task ? "SQLite 已入队" : "hello · build" },
        { id: "n2", x: 198, y: 46, w: 158, h: 58, tone: st.prep, title: "0700 隔离目录", sub: "复制源码至 src/" },
        { id: "n3", x: 384, y: 46, w: 160, h: 58, tone: st.exec, title: "zipapp 打包", sub: task ? `耗时 ${durLabel}` : "输出 out/app.pyz" },
        { id: "n4", x: 572, y: 46, w: 156, h: 58, tone: st.clean, title: "清理临时目录", sub: st.clean === "done" ? "work/<id> 已删" : "暂存并删目录" },
        { id: "n5", x: 754, y: 46, w: 152, h: 58, tone: st.pub, title: "发布下载产物", sub: hasPyz ? "app.pyz 就绪" : "持久化 SQLite" },
      ],
      edges: [
        { from: "n1", to: "n2", tone: st.queued },
        { from: "n2", to: "n3", tone: st.prep === "done" ? (st.exec === "active" ? "active" : "done") : "idle" },
        { from: "n3", to: "n4", tone: st.clean === "done" ? "done" : st.exec === "active" ? "active" : "idle" },
        { from: "n4", to: "n5", tone: st.pub === "done" ? "done" : "idle" },
      ],
    };
  }

  if (scenarioId === "fail") {
    const isMatch = task && task.project_id.startsWith("broken");
    const t = isMatch ? task : null;
    const st = singleLifecycleStages(t);
    const hasTraceback = isMatch && (logs?.text || "").includes("AssertionError");
    return {
      viewBox: "0 0 920 150",
      nodes: [
        { id: "n1", x: 16, y: 46, w: 152, h: 58, tone: st.queued, title: "提交计费测试", sub: "broken · test" },
        { id: "n2", x: 196, y: 46, w: 162, h: 58, tone: st.exec === "error" ? "done" : st.exec, title: "运行 unittest", sub: "执行 3 项计费测试" },
        { id: "n3", x: 386, y: 46, w: 162, h: 58, tone: hasTraceback ? "error" : st.exec, title: "捕获断言异常", sub: hasTraceback ? "AssertionError: 20!=21" : "合并 stdout/stderr" },
        { id: "n4", x: 576, y: 46, w: 152, h: 58, tone: st.clean, title: "清理私有沙箱", sub: st.clean === "done" ? "目录已清理" : "回收进程与目录" },
        { id: "n5", x: 754, y: 46, w: 152, h: 58, tone: t?.status === "succeeded" ? "done" : st.pub, title: t?.status === "succeeded" ? "修复通过 rc=0" : "记录失败 rc=1", sub: t ? `状态: ${statusText(t)}` : "生成 result.json" },
      ],
      edges: [
        { from: "n1", to: "n2", tone: st.queued },
        { from: "n2", to: "n3", tone: hasTraceback ? "error" : st.exec === "active" ? "active" : st.pub === "done" ? "done" : "idle" },
        { from: "n3", to: "n4", tone: st.clean === "done" ? (t?.status === "failed" ? "error" : "done") : "idle" },
        { from: "n4", to: "n5", tone: st.pub },
      ],
    };
  }

  if (scenarioId === "cancel") {
    const isSlow = task && task.project_id === "slow";
    const t = isSlow ? task : null;
    const logText = isSlow ? logs?.text || "" : "";
    const childReady = logText.includes("child_ready=");
    const cancelSent = Boolean(t && (t.stop_reason === "cancelled" || t.status === "cancelled"));
    const finishedCancel = Boolean(t && t.status === "cancelled");

    return {
      viewBox: "0 0 920 194",
      nodes: [
        { id: "c1", x: 16, y: 22, w: 162, h: 58, tone: t ? "done" : "idle", title: "建立新会话进程组", sub: "start_new_session=True" },
        { id: "c2", x: 214, y: 22, w: 174, h: 58, tone: finishedCancel ? "done" : childReady ? "active" : t ? "active" : "idle", title: "派生忽略 TERM 子进程", sub: childReady ? "已捕获 child_ready" : "设置 SIG_IGN" },
        { id: "c_req", x: 214, y: 114, w: 174, h: 58, tone: cancelSent ? "warn" : "idle", title: "POST /cancel", sub: cancelSent ? "已登记取消 (202)" : "发起运行中取消" },
        { id: "c3", x: 492, y: 66, w: 188, h: 58, tone: finishedCancel ? "done" : cancelSent ? "active" : "idle", title: "整组分级信号回收", sub: "killpg TERM → KILL" },
        { id: "c4", x: 720, y: 66, w: 184, h: 58, tone: finishedCancel ? "warn" : "idle", title: "进程清空 & 删目录", sub: finishedCancel ? `cancelled · rc=${t.exit_code ?? "—"}` : "零残留发布终态" },
      ],
      edges: [
        { from: "c1", to: "c2", tone: t ? "done" : "idle" },
        { from: "c2", to: "c3", tone: finishedCancel ? "done" : childReady ? "active" : "idle" },
        { from: "c_req", to: "c3", tone: cancelSent ? "warn" : "idle", label: "触发中断" },
        { from: "c3", to: "c4", tone: finishedCancel ? "warn" : cancelSent ? "active" : "idle" },
      ],
    };
  }

  if (scenarioId === "timeout") {
    const isTimeoutRun = task && task.project_id === "slow" && task.timeout_seconds <= 5;
    const t = isTimeoutRun ? task : null;
    const timedOut = Boolean(t && t.status === "timeout");
    const running = Boolean(t && t.status === "running");

    return {
      viewBox: "0 0 920 194",
      nodes: [
        { id: "t1", x: 16, y: 22, w: 164, h: 58, tone: t ? "done" : "idle", title: "设定单调时钟截止点", sub: "monotonic + 2.0s" },
        { id: "t2", x: 214, y: 22, w: 174, h: 58, tone: timedOut ? "done" : running ? "active" : "idle", title: "kqueue 监听管道/退出", sub: running ? `运行中 ${durLabel} / 2s` : "非阻塞收集输出" },
        { id: "t_clock", x: 214, y: 114, w: 174, h: 58, tone: timedOut ? "warn" : running ? "active" : "idle", title: "2.0s 看门狗到期", sub: timedOut ? "达到执行时限" : "排队不消耗时限" },
        { id: "t3", x: 492, y: 66, w: 188, h: 58, tone: timedOut ? "done" : "idle", title: "强杀超时进程树", sub: "回收主进程与子进程" },
        { id: "t4", x: 720, y: 66, w: 184, h: 58, tone: timedOut ? "warn" : "idle", title: "删目录 & 发布超时", sub: timedOut ? "status = timeout" : "生成超时报告" },
      ],
      edges: [
        { from: "t1", to: "t2", tone: t ? "done" : "idle" },
        { from: "t2", to: "t3", tone: timedOut ? "warn" : running ? "active" : "idle" },
        { from: "t_clock", to: "t3", tone: timedOut ? "warn" : running ? "active" : "idle", label: "到期中断" },
        { from: "t3", to: "t4", tone: timedOut ? "warn" : "idle" },
      ],
    };
  }

  if (scenarioId === "concurrency") {
    const batch = batchTasks || [];
    const hasBatch = batch.length > 0;
    const runningBatch = batch.filter((b) => b.status === "running");
    const queuedBatch = batch.filter((b) => b.status === "queued");
    const doneBatch = batch.filter((b) => b.status === "succeeded");
    const allDone = hasBatch && doneBatch.length === batch.length;

    const slot1Task = runningBatch[0] || (allDone ? batch[2] || batch[0] : null);
    const slot2Task = runningBatch[1] || (allDone ? batch[3] || batch[1] : null);

    const slot1Tone = runningBatch[0] ? "active" : allDone ? "done" : "idle";
    const slot2Tone = runningBatch[1] ? "active" : allDone ? "done" : "idle";
    const queueTone = queuedBatch.length > 0 ? "warn" : hasBatch ? "done" : "idle";

    return {
      viewBox: "0 0 920 210",
      nodes: [
        {
          id: "p_in",
          x: 18,
          y: 76,
          w: 172,
          h: 58,
          tone: hasBatch ? "done" : "idle",
          title: "并发提交 4 个任务",
          sub: hasBatch ? `完成 ${doneBatch.length} / ${batch.length}` : "2×流水线 + 检查 + 构建",
        },
        {
          id: "p_w1",
          x: 298,
          y: 12,
          w: 224,
          h: 55,
          tone: slot1Tone,
          title: "Worker 槽 #1 (独立沙箱)",
          sub: slot1Task ? `${slot1Task.project_id} · ${slot1Task.type} (${statusText(slot1Task)})` : "并发槽 1 / 2",
        },
        {
          id: "p_w2",
          x: 298,
          y: 78,
          w: 224,
          h: 55,
          tone: slot2Tone,
          title: "Worker 槽 #2 (独立沙箱)",
          sub: slot2Task ? `${slot2Task.project_id} · ${slot2Task.type} (${statusText(slot2Task)})` : "并发槽 2 / 2",
        },
        {
          id: "p_q",
          x: 298,
          y: 144,
          w: 224,
          h: 55,
          tone: queueTone,
          title: "FIFO 队列 (上限 32)",
          sub:
            queuedBatch.length > 0
              ? `${queuedBatch.length} 个任务排队候补…`
              : hasBatch
                ? "已自动补位执行"
                : `排队 ${queuedCount || 0} / 32`,
        },
        {
          id: "p_out",
          x: 642,
          y: 76,
          w: 256,
          h: 58,
          tone: allDone ? "done" : runningBatch.length > 0 ? "active" : "idle",
          title: "各自回收沙箱 & 交付产物",
          sub: allDone ? "4 任务零冲突完成" : "同名临时文件互不污染",
        },
      ],
      edges: [
        { from: "p_in", to: "p_w1", tone: slot1Tone === "active" ? "active" : hasBatch ? "done" : "idle", label: "领取" },
        { from: "p_in", to: "p_w2", tone: slot2Tone === "active" ? "active" : hasBatch ? "done" : "idle", label: "并行" },
        { from: "p_in", to: "p_q", tone: queuedBatch.length > 0 ? "warn" : hasBatch ? "done" : "idle", label: "满槽入队" },
        { from: "p_w1", to: "p_out", tone: slot1Tone },
        { from: "p_w2", to: "p_out", tone: slot2Tone },
        { from: "p_q", to: "p_out", tone: allDone ? "done" : queuedBatch.length > 0 ? "active" : "idle", label: "自动补位" },
      ],
    };
  }

  const isFlood = task && task.project_id === "logflood";
  const t = isFlood ? task : null;
  const isTrunc = Boolean(isFlood && logs?.truncated);
  const done = Boolean(t && t.status === "succeeded");

  return {
    viewBox: "0 0 920 194",
    nodes: [
      { id: "l1", x: 18, y: 66, w: 166, h: 58, tone: t ? "done" : "idle", title: "输出 96 KB 日志流", sub: "logflood · 1,200 行" },
      { id: "l2", x: 226, y: 66, w: 174, h: 58, tone: done ? "done" : t ? "active" : "idle", title: "非阻塞分块读取", sub: "kqueue 管道监听" },
      { id: "l_keep", x: 452, y: 20, w: 202, h: 58, tone: done ? "done" : "idle", title: "保存前 64.0 KB", sub: isFlood ? `已存 ${formatBytes((logs?.text || "").length)}` : "限制存储体积" },
      { id: "l_drain", x: 452, y: 114, w: 202, h: 58, tone: isTrunc ? "warn" : "idle", title: "标记截断并排空", sub: isTrunc ? "truncated = true" : "防写满管道阻塞" },
      { id: "l_out", x: 706, y: 66, w: 194, h: 58, tone: done ? "done" : "idle", title: "正常完成 rc=0", sub: done ? "无挂起、无死锁" : "优雅关闭管道" },
    ],
    edges: [
      { from: "l1", to: "l2", tone: t ? "done" : "idle" },
      { from: "l2", to: "l_keep", tone: done ? "done" : t ? "active" : "idle", label: "≤ 64 KB" },
      { from: "l2", to: "l_drain", tone: isTrunc ? "warn" : t ? "active" : "idle", label: "> 64 KB" },
      { from: "l_keep", to: "l_out", tone: done ? "done" : "idle" },
      { from: "l_drain", to: "l_out", tone: done ? "done" : "idle" },
    ],
  };
}
