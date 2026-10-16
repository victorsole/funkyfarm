"""Container-only credential wiring; the API never receives migration secrets."""

import os
from pathlib import Path
import stat
import sys
from urllib.parse import quote


def required(name):
    value = os.environ.get(name, "")
    if len(value) < 20 or "\x00" in value or "\n" in value or "\r" in value:
        raise SystemExit(f"Set {name} to a fresh single-line value of at least 20 characters.")
    return value


def connection(user, password):
    host = os.environ.get("FUNKYFARMERS_DATABASE_HOST", "database")
    name = os.environ.get("FUNKYFARMERS_DATABASE_NAME", "funkyfarmers")
    if not host.replace("-", "").isalnum() or not name.replace("_", "").isalnum():
        raise SystemExit("Container database host/name is invalid.")
    return f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}@{host}:5432/{quote(name, safe='')}"


def main():
    os.umask(0o077)
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    runtime_password = required("FUNKYFARMERS_RUNTIME_PASSWORD")
    if mode == "migrate":
        admin = required("FUNKYFARMERS_ADMIN_PASSWORD")
        os.environ["FUNKYFARMERS_ADMIN_DATABASE_URL"] = connection("funkyfarmers_migrator", admin)
        os.execvp("python", ["python", "-m", "funkyfarmers.migrate"])
    if mode != "api":
        raise SystemExit("Choose api or migrate.")
    if os.environ.get("FUNKYFARMERS_ADMIN_PASSWORD") or os.environ.get("FUNKYFARMERS_ADMIN_DATABASE_URL"):
        raise SystemExit("Migration credentials must not be supplied to the API container.")
    os.environ["FUNKYFARMERS_DATABASE_URL"] = connection("funkyfarmers_app", runtime_password)
    root = Path(os.environ["FUNKYFARMERS_STORAGE_ROOT"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    details = root.lstat()
    if not stat.S_ISDIR(details.st_mode) or root.is_symlink() or details.st_uid != os.getuid():
        raise SystemExit("Private originals volume must be a real directory owned by the runtime user.")
    if stat.S_IMODE(details.st_mode) & 0o077:
        raise SystemExit("Private originals volume must have mode 0700.")
    os.execvp("python", ["python", "-m", "uvicorn", "funkyfarmers.app:app", "--host", "0.0.0.0",
                         "--port", "8139", "--workers", "1", "--no-proxy-headers", "--no-access-log"])


if __name__ == "__main__":
    main()
