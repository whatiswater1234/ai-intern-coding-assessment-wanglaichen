"""Safe archive normalization, extraction and source inspection for task workspaces."""

import io
import stat
import zipfile
from pathlib import Path, PurePosixPath

from .storage import ServiceError

ARCHIVE_LIMIT = 2 * 1024 * 1024
MAX_FILES = 64
FORBIDDEN_PARTS = {"", ".", "..", ".git", "__pycache__"}


def clean_relpath(raw: str) -> str:
    if not raw or len(raw) > 200 or "\x00" in raw or "\\" in raw or raw.startswith("/"):
        raise ServiceError(422, "invalid_path", f"非法文件路径: {raw!r}")
    pure = PurePosixPath(raw)
    if pure.is_absolute() or any(part in FORBIDDEN_PARTS for part in pure.parts):
        raise ServiceError(422, "invalid_path", f"路径包含受限目录段: {raw!r}")
    return pure.as_posix()


def pack_inline_files(files: dict[str, str]) -> bytes:
    if not files or len(files) > MAX_FILES:
        raise ServiceError(422, "invalid_files", f"源码文件数量须在 1–{MAX_FILES} 之间")
    seen = {}
    total = 0
    for raw_path, content in files.items():
        norm = clean_relpath(raw_path)
        if norm in seen:
            raise ServiceError(422, "duplicate_path", f"重复的文件路径: {norm}")
        encoded = content.encode("utf-8")
        total += len(encoded)
        if total > ARCHIVE_LIMIT:
            raise ServiceError(413, "source_too_large", "源码总大小超过 2 MiB 上限")
        seen[norm] = encoded

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(seen):
            info = zipfile.ZipInfo(path)
            info.external_attr = 0o600 << 16
            zf.writestr(info, seen[path])
    return buf.getvalue()


def normalize_zip_archive(raw_bytes: bytes) -> bytes:
    if not raw_bytes:
        raise ServiceError(422, "empty_archive", "上传的压缩包为空")
    if len(raw_bytes) > ARCHIVE_LIMIT:
        raise ServiceError(413, "archive_too_large", "压缩包超过 2 MiB 上限")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
    except zipfile.BadZipFile as exc:
        raise ServiceError(422, "invalid_archive", "无法解析 ZIP 压缩包") from exc

    entries: dict[str, bytes] = {}
    total = 0
    with zf:
        for info in zf.infolist():
            name = info.filename
            if name.startswith("__MACOSX/") or name.endswith("/.DS_Store") or name == ".DS_Store":
                continue
            if info.flag_bits & 0x1:
                raise ServiceError(422, "encrypted_archive", "不支持加密的 ZIP 压缩包")
            mode = info.external_attr >> 16
            file_type = stat.S_IFMT(mode)
            if file_type == stat.S_IFLNK:
                raise ServiceError(422, "symlink_denied", "压缩包内不允许包含符号链接")
            if info.is_dir() or file_type == stat.S_IFDIR:
                continue
            if file_type not in (0, stat.S_IFREG):
                raise ServiceError(422, "special_file_denied", "压缩包只允许包含普通文件")

            norm = clean_relpath(name)
            if norm in entries:
                raise ServiceError(422, "duplicate_path", f"压缩包内存在重复路径: {norm}")
            if len(entries) >= MAX_FILES:
                raise ServiceError(422, "too_many_files", f"压缩包文件数超过 {MAX_FILES} 上限")

            with zf.open(info, "r") as reader:
                chunk = reader.read(ARCHIVE_LIMIT + 1 - total)
            total += len(chunk)
            if total > ARCHIVE_LIMIT:
                raise ServiceError(413, "archive_too_large", "解压后总大小超过 2 MiB 上限")
            entries[norm] = chunk

    if not entries:
        raise ServiceError(422, "empty_archive", "压缩包内没有有效源码文件")

    # Unwrap a single outer folder (e.g. macOS Finder "Compress folder/") when no root files exist.
    parts_list = [PurePosixPath(p).parts for p in entries]
    if all(len(parts) > 1 for parts in parts_list):
        roots = {parts[0] for parts in parts_list}
        if len(roots) == 1:
            entries = {
                PurePosixPath(*PurePosixPath(p).parts[1:]).as_posix(): data
                for p, data in entries.items()
            }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as out_zf:
        for path in sorted(entries):
            info = zipfile.ZipInfo(path)
            info.external_attr = 0o600 << 16
            out_zf.writestr(info, entries[path])
    return buf.getvalue()


def extract_archive(archive_bytes: bytes, target: Path, checkpoint) -> None:
    target.mkdir()
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
        for info in zf.infolist():
            checkpoint()
            rel = clean_relpath(info.filename)
            dest = target / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info, "r") as reader, dest.open("xb") as writer:
                while chunk := reader.read(256 * 1024):
                    checkpoint()
                    writer.write(chunk)


def _decode_preview(raw: bytes) -> tuple[str, bool]:
    if b"\x00" in raw[:4096]:
        return "", True
    try:
        return raw.decode("utf-8"), False
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace"), True


def inspect_directory_files(folder: Path) -> list[dict]:
    if folder.is_symlink() or not folder.is_dir():
        raise ServiceError(404, "project_not_found", "预置项目不存在")
    items = []
    pending = [folder]
    while pending:
        current = pending.pop()
        for entry in sorted(current.iterdir(), key=lambda p: p.name, reverse=True):
            if entry.name.startswith(".") or entry.name == "__pycache__":
                continue
            mode = entry.lstat().st_mode
            if stat.S_ISDIR(mode):
                pending.append(entry)
            elif stat.S_ISREG(mode):
                raw = entry.read_bytes()
                content, binary = _decode_preview(raw[:65536])
                items.append(
                    {
                        "path": entry.relative_to(folder).as_posix(),
                        "size_bytes": len(raw),
                        "binary": binary,
                        "content": content,
                    }
                )
    items.sort(key=lambda x: x["path"])
    return items


def inspect_archive_files(archive_bytes: bytes) -> list[dict]:
    items = []
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
        for info in sorted(zf.infolist(), key=lambda i: i.filename):
            if info.is_dir():
                continue
            raw = zf.read(info.filename)
            content, binary = _decode_preview(raw[:65536])
            items.append(
                {
                    "path": info.filename,
                    "size_bytes": len(raw),
                    "binary": binary,
                    "content": content,
                }
            )
    return items
