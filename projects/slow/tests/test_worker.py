import os
import subprocess
import sys
import unittest


class WorkerTests(unittest.TestCase):
    def test_long_job(self):
        child_code = (
            "import os, signal, time\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "print(f'child_ready={os.getpid()} (子进程已设置忽略 SIGTERM)', flush=True)\n"
            "for step in range(1, 13):\n"
            "    print(f'[step {step:02d}/12] 正在流式扫描归档分片并校验索引...', flush=True)\n"
            "    time.sleep(1.0)\n"
        )
        print(f"leader={os.getpid()} (独立会话进程组已启动)", flush=True)
        with subprocess.Popen([sys.executable, "-c", child_code]) as worker:
            self.assertEqual(worker.wait(), 0)
