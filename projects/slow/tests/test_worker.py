import os
import subprocess
import sys
import unittest


class WorkerTests(unittest.TestCase):
    def test_long_job(self):
        child_code = (
            "import os, signal, time\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "print(f'child_ready={os.getpid()}', flush=True)\n"
            "time.sleep(12)"
        )
        print(f"leader={os.getpid()}", flush=True)
        with subprocess.Popen([sys.executable, "-c", child_code]) as worker:
            self.assertEqual(worker.wait(), 0)
