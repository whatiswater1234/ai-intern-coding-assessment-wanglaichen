import sys
import unittest


class LogCapTests(unittest.TestCase):
    def test_high_volume_stream_drains_cleanly(self):
        # 输出约 96 KiB 日志，验证服务端保留前 64 KiB、标记 truncated=true 且持续排空管道不死锁
        for i in range(1, 1201):
            sys.stdout.write(
                f"[line {i:04d}] benchmark_trace payload_bytes=82 status=ok checksum={i * 97:06d}\n"
            )
        sys.stdout.flush()
        self.assertTrue(True)
