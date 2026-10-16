"""Check the real runtime role/database and a private-volume write/read cycle."""

import json
import os
from pathlib import Path
import stat
import tempfile
from urllib.request import urlopen


def main():
    with urlopen("http://127.0.0.1:8139/health", timeout=5) as response:
        value = json.load(response)
        if value.get("status") != "ok" or value.get("database") != "postgresql" or value.get("isolation") != "force_rls":
            raise RuntimeError("Database/runtime health check failed")
    root = Path(os.environ["FUNKYFARM_STORAGE_ROOT"])
    info = root.lstat()
    if root.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError("Private originals directory permissions are invalid")
    os.umask(0o077)
    with tempfile.TemporaryFile(dir=root) as probe:
        probe.write(b"funkyfarm-private-volume-health")
        probe.flush()
        os.fsync(probe.fileno())
        probe.seek(0)
        if probe.read() != b"funkyfarm-private-volume-health":
            raise RuntimeError("Private originals write/read check failed")


if __name__ == "__main__":
    main()
