"""Explicit local backup and isolated recovery. Never restores over the source.

backup --destination <new directory below runtime/backups> [--project funkyfarm-local]
rehearse --bundle <backup directory> --project funkyfarm-recovery-<unique suffix>

Rehearsal resources are retained, stopped, for inspection. There is no automatic
volume deletion and no command that resets the original database.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import subprocess
import tarfile


ROOT = Path(__file__).resolve().parents[1]
BACKUPS = ROOT / "runtime" / "backups"
FILES = ("database.dump", "originals.tar", "counts.json")
MAX_BYTES = 4 * 1024 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 100_000


def run(arguments, environment=None, timeout=180):
    result = subprocess.run(arguments, env=environment, cwd=ROOT, text=True,
                            capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        # Do not print the environment or a Compose config containing credentials.
        raise RuntimeError(f"Local Docker operation failed (exit {result.returncode}): {result.stderr[-2000:]}")
    return result.stdout.strip()


def local_engine():
    explicit_host = os.environ.get("DOCKER_HOST", "")
    if explicit_host and not explicit_host.startswith(("npipe://", "unix://")):
        raise RuntimeError("Recovery only permits a local Unix socket or Windows named-pipe Docker engine.")
    context = run(["docker", "context", "show"])
    info = json.loads(run(["docker", "context", "inspect", context]))
    endpoint = info[0]["Endpoints"]["docker"]["Host"]
    if not endpoint.startswith(("npipe://", "unix://")):
        raise RuntimeError("The selected Docker context is remote; no recovery operation was started.")


def compose(project, recovery=False):
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,63}", project):
        raise ValueError("Choose an explicit Compose project name using lowercase letters, digits, hyphens or underscores.")
    source = ROOT / "containers" / "compose.recovery.yaml" if recovery else ROOT / "compose.yaml"
    return ["docker", "compose", "--project-name", project, "--file", str(source)]


def hash_file(path):
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return digest


def safe_bundle(path, new=False):
    candidate = Path(path).absolute()
    anchor = BACKUPS.resolve()
    # Refuse existing symlink/junction components before resolving the final path.
    for parent in (candidate, *candidate.parents):
        if parent.is_symlink() or (hasattr(parent, "is_junction") and parent.is_junction()):
            raise ValueError("Backup paths must not traverse symlinks or junctions.")
    candidate = candidate.resolve()
    if candidate == anchor or not candidate.is_relative_to(anchor):
        raise ValueError(f"Choose a distinct bundle directory below {anchor}.")
    if new:
        if candidate.exists():
            raise ValueError("Backup requires a new destination directory; existing data will not be overwritten.")
    elif not candidate.is_dir():
        raise ValueError("The selected backup bundle does not exist.")
    return candidate


def inspect_archive(path):
    total = 0
    count = 0
    contents = {}
    with tarfile.open(path, mode="r:") as archive:
        for item in archive:
            count += 1
            target = PurePosixPath(item.name)
            if count > MAX_ARCHIVE_MEMBERS or target.is_absolute() or ".." in target.parts:
                raise ValueError("Backup archive contains an unsafe path or exceeds the entry limit.")
            if not item.isfile() and not item.isdir():
                raise ValueError("Backup archives may contain only regular files and directories, never links or devices.")
            if item.isfile():
                total += item.size
                if total > MAX_BYTES:
                    raise ValueError("Backup archive exceeds the recovery size limit.")
                normalized = str(target)
                if normalized in contents:
                    raise ValueError("Backup archive contains duplicate file names.")
                stream = archive.extractfile(item)
                if stream is None:
                    raise ValueError("Backup archive contains an unreadable file.")
                with stream:
                    contents[normalized] = hashlib.file_digest(stream, "sha256").hexdigest()
    return contents


def verify_bundle(bundle):
    manifest_path = bundle / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file() or manifest_path.stat().st_size > 65536:
        raise ValueError("Backup manifest must be a small regular file.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != "funkyfarm-local-backup-v1" or set(manifest.get("sha256", {})) != set(FILES):
        raise ValueError("Backup manifest format is invalid.")
    size = 0
    for name in FILES:
        path = bundle / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Backup contains a missing file or symlink.")
        size += path.stat().st_size
        if size > MAX_BYTES or hash_file(path) != manifest["sha256"][name]:
            raise ValueError("Backup is too large or failed its SHA-256 integrity check.")
    inspect_archive(bundle / "originals.tar")
    counts = json.loads((bundle / "counts.json").read_text(encoding="utf-8"))
    if not isinstance(counts, dict) or any(not isinstance(value, int) or value < 0 for value in counts.values()):
        raise ValueError("Backup row-count evidence is invalid.")
    return manifest


def backup(arguments):
    bundle = safe_bundle(arguments.destination, new=True)
    command = compose(arguments.project)
    running = set(run(command + ["ps", "--status", "running", "--services"]).splitlines())
    if "database" not in running or "api" not in running:
        raise RuntimeError("Backup requires the selected source database and API to be running.")
    writers = [service for service in ("web", "api") if service in running]
    bundle.mkdir(parents=True, mode=0o700)
    environment = dict(os.environ, FUNKYFARM_BACKUP_DIRECTORY=str(bundle))
    try:
        run(command + ["stop", "--timeout", "30", *writers])
        run(command + ["--profile", "maintenance", "run", "--rm", "--no-deps", "backup"], environment)
        if sum((bundle / name).stat().st_size for name in FILES) > MAX_BYTES:
            raise ValueError("Backup bundle exceeds the size limit; it remains unverified.")
        inspect_archive(bundle / "originals.tar")
        manifest = {
            "format": "funkyfarm-local-backup-v1",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source_project": arguments.project,
            "sha256": {name: hash_file(bundle / name) for name in FILES},
            "consistency": "Selected Compose API/web stopped during capture; operator must exclude any other writers.",
            "recovery_verified": False,
        }
        (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        verify_bundle(bundle)
    finally:
        run(command + ["start", *writers])
    print(f"Local backup captured and integrity-checked: {bundle}")
    print("Recovery remains unverified until the isolated rehearsal succeeds.")


def unused_project(project):
    if not re.fullmatch(r"funkyfarm-recovery-[a-z0-9][a-z0-9-]{7,39}", project):
        raise ValueError("Recovery requires an explicit fresh funkyfarm-recovery-<8..40 character suffix> project.")
    label = f"label=com.docker.compose.project={project}"
    for query in (["docker", "ps", "--all", "--quiet", "--filter", label],
                  ["docker", "volume", "ls", "--quiet", "--filter", label],
                  ["docker", "network", "ls", "--quiet", "--filter", label]):
        if run(query):
            raise ValueError("Recovery refuses a project that already has containers, volumes or networks. Choose a new name.")


def rehearse(arguments):
    bundle = safe_bundle(arguments.bundle)
    verify_bundle(bundle)
    expected_files = inspect_archive(bundle / "originals.tar")
    unused_project(arguments.project)
    environment = dict(os.environ,
                       FUNKYFARM_BACKUP_DIRECTORY=str(bundle),
                       FUNKYFARM_ADMIN_PASSWORD=secrets.token_urlsafe(36),
                       FUNKYFARM_RUNTIME_PASSWORD=secrets.token_urlsafe(36))
    command = compose(arguments.project, recovery=True)
    succeeded = False
    try:
        run(command + ["up", "--detach", "--wait", "--wait-timeout", "150", "api"], environment, timeout=180)
        # The restore helper has exited; a new helper only reads the isolated DB.
        observed = run(command + ["run", "--rm", "--no-deps", "--entrypoint", "psql", "restore",
                                  "--no-password", "--no-psqlrc", "--tuples-only", "--no-align",
                                  "--set=ON_ERROR_STOP=1", "--file=/tools/recovery-counts.sql"], environment)
        if json.loads(observed) != json.loads((bundle / "counts.json").read_text(encoding="utf-8")):
            raise RuntimeError("Restored database row counts differ from the captured source.")
        verifier = (
            "import hashlib,json,pathlib; root=pathlib.Path('/var/lib/funkyfarm/private-documents'); "
            "print(json.dumps({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() "
            "for p in root.rglob('*') if p.is_file()},sort_keys=True))"
        )
        actual_files = json.loads(run(command + ["exec", "-T", "api", "python", "-c", verifier], environment))
        if actual_files != expected_files:
            raise RuntimeError("Recovered private originals differ from the captured evidence bytes.")
        succeeded = True
        result = {
            "project": arguments.project,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "source_bundle": str(bundle),
            "database_row_counts_match": True,
            "private_original_sha256_match": True,
            "api_database_and_storage_health": True,
            "limits": "Local isolated restoration only. Account journeys, denied cross-workspace access, issued-report rendering and operator recovery time need separate verification.",
        }
        result_path = bundle / f"{arguments.project}.result.json"
        if result_path.exists():
            raise RuntimeError("A recovery result already exists; it will not be overwritten.")
        result_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(f"Isolated database row counts, evidence hashes and API/storage health matched: {result_path}")
    finally:
        run(command + ["stop", "--timeout", "20"], environment)
        state = "matched the bounded checks" if succeeded else "did not complete"
        print(f"Recovery {state}; stopped project {arguments.project} is retained for inspection. Original project untouched.")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    capture = actions.add_parser("backup")
    capture.add_argument("--destination", required=True)
    capture.add_argument("--project", default="funkyfarm-local")
    restore = actions.add_parser("rehearse")
    restore.add_argument("--bundle", required=True)
    restore.add_argument("--project", required=True)
    arguments = parser.parse_args()
    local_engine()
    backup(arguments) if arguments.action == "backup" else rehearse(arguments)


if __name__ == "__main__":
    main()
