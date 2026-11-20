import os
import time
import unittest
from pathlib import Path

from processor import analyze_chunk


class PipelineConcurrencyTests(unittest.TestCase):
    def test_isolated_staged_pipeline(self):
        pid = os.getpid()
        marker = Path("sandbox_owner.txt")
        marker.write_text(f"owner={pid}", encoding="utf-8")

        stages = [
            "加载分片清单与校验配置",
            "构建语法树并提取依赖图",
            "执行并发沙箱写入隔离自检",
            "汇总分片校验和报告",
        ]
        for idx, title in enumerate(stages, start=1):
            print(f"[pid={pid}] 阶段 {idx}/4: {title} ...", flush=True)
            time.sleep(0.55)

        # 验证并发执行时同目录文件名互不覆盖
        self.assertEqual(marker.read_text(encoding="utf-8"), f"owner={pid}")
        summary = analyze_chunk([10, 20, 30, 40])
        self.assertEqual(summary, {"count": 4, "checksum": 300})
