import subprocess
import sys
import tempfile
from pathlib import Path

from local_service import LocalService, until


def main():
    with tempfile.TemporaryDirectory() as folder:
        api = LocalService(folder)
        try:
            api.start()
            print(f"本机服务  {api.url}", flush=True)
            for project, expected in [("hello", "succeeded"), ("broken", "failed")]:
                path = api.submit(project)
                row = api.finished(path)
                print(f"{project} test  {row['status']}，退出码 {row['exit_code']}")
                print(api.get(path + "/logs")["text"].rstrip())
                assert row["status"] == expected
            slow = api.submit("slow")

            def live_output():
                text = api.get(slow + "/logs")["text"]
                return text if "child_ready=" in text else None

            live = until(live_output)
            print("运行中的日志", live.strip(), sep="\n")
            api.request(slow + "/cancel", "POST")
            assert api.finished(slow)["status"] == "cancelled"
            print("慢任务已取消，临时目录已回收")
            assert not (api.data / "work" / slow.rsplit("/", 1)[1]).exists()
            build = api.submit(kind="build")
            assert api.finished(build)["status"] == "succeeded"
            print("可下载产物", [item["name"] for item in api.get(build + "/artifacts")["items"]])
            archive = Path(folder) / "demo.pyz"
            archive.write_bytes(api.get(build + "/artifacts/app.pyz"))
            output = subprocess.check_output([sys.executable, archive], text=True).strip()
            assert output == "Hello, Mac!"
            print("下载并运行 app.pyz →", output)
            print("AI 验证记录见 docs/AI_USAGE.md；可重放 tests/e2e 中的进程回收实验。")
        finally:
            api.stop()


if __name__ == "__main__":
    main()
