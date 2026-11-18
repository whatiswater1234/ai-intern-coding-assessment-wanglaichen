import argparse
import os
import sys
from pathlib import Path

import uvicorn

from .api import build_app
from .scheduler import REPO


def main():
    parser = argparse.ArgumentParser(description="macOS 本机代码任务执行服务")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=Path(".task-service"))
    parser.add_argument(
        "--projects", type=Path, default=REPO / "projects", help="维护者提供的可信项目根目录"
    )
    options = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("运行环境需要 macOS")
    os.umask(0o077)
    app = build_app(options.data_dir.resolve(), options.projects.resolve())
    uvicorn.run(app, host="127.0.0.1", port=options.port, access_log=False, proxy_headers=False)


if __name__ == "__main__":
    main()
