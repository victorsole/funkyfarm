"""Pinned local model cache, separate from the network-isolated inference server.

The fetch companion handles only reviewed public weight blobs, never farmer
prompts or API credentials. Missing/failed cache means unavailable chat, not a
failed farmer API. No pull endpoint, mutable model tag, shell or remote model.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time
import urllib.request


MANIFEST_DIGEST = "359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7"
ALIAS = "funkyfarm-qwen3:" + MANIFEST_DIGEST
TOTAL_BYTES = 2497293931
MAX_CACHE_BYTES = 3 * 1024**3
MIN_FREE_BYTES = 8 * 1024**3
ROOT = Path("/models")
SOURCE = Path(__file__).with_name("ollama-model.json")


def checked_manifest(source=SOURCE):
    raw = source.read_bytes().rstrip(b"\r\n")
    if hashlib.sha256(raw).hexdigest() != MANIFEST_DIGEST:
        raise ValueError("Reviewed model manifest identity differs")
    document = json.loads(raw)
    blobs = [document["config"], *document["layers"]]
    if sum(blob["size"] for blob in blobs) != TOTAL_BYTES:
        raise ValueError("Reviewed model size differs")
    for blob in blobs:
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", blob["digest"]) or not 0 < blob["size"] <= MAX_CACHE_BYTES:
            raise ValueError("Invalid immutable blob identity")
    return raw, document, blobs


def safe_path(path, root=None):
    root = ROOT if root is None else root
    if root.is_symlink() or not root.is_dir() or root.resolve() != root:
        raise ValueError("Model cache must be a real, app-owned directory")
    if not path.is_relative_to(root):
        raise ValueError("Model path leaves app cache")
    for item in (path, *path.parents):
        if item == root.parent:
            break
        if item.is_symlink():
            raise ValueError("Model cache may not contain symbolic links")
    return path


def file_matches(path, blob):
    if not path.exists():
        return False
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or details.st_size != blob["size"]:
        raise ValueError("Existing model cache entry has an unexpected type or size")
    with path.open("rb") as stream:
        return "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest() == blob["digest"]


def publish(path, content):
    safe_path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = safe_path(path.with_name(path.name + ".pending"))
    with temporary.open("xb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def download_blob(blob, *, root=None, opener=None):
    root = ROOT if root is None else root
    path = safe_path(root / "blobs" / blob["digest"].replace(":", "-"), root)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if file_matches(path, blob):
        return
    if path.exists():
        raise ValueError("Existing cached blob failed integrity; no overwrite attempted")
    if shutil.disk_usage(root).free < MIN_FREE_BYTES:
        raise ValueError("Less than 8 GiB free; no other application data was removed")
    temporary = safe_path(path.with_name(path.name + ".pending"), root)
    # Retry only this exact bounded incomplete blob. Never delete a directory.
    if temporary.exists():
        if not stat.S_ISREG(temporary.lstat().st_mode) or temporary.stat().st_size > blob["size"]:
            raise ValueError("Unexpected incomplete model blob")
        temporary.unlink()
    request = urllib.request.Request(
        "https://registry.ollama.ai/v2/library/qwen3/blobs/" + blob["digest"],
        headers={"User-Agent": "FunkyFarm-Pinned-Model-Cache/1.0"},
    )
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}))
    digest = hashlib.sha256()
    count = 0
    started = time.monotonic()
    with opener.open(request, timeout=60) as response, temporary.open("xb") as destination:
        if response.status != 200 or not response.url.startswith("https://"):
            raise ValueError("Expected secure full official model blob")
        while chunk := response.read(1024 * 1024):
            count += len(chunk)
            if count > blob["size"] or time.monotonic() - started > 1800:
                raise ValueError("Model download exceeded reviewed bounds")
            destination.write(chunk)
            digest.update(chunk)
        destination.flush()
        os.fsync(destination.fileno())
    if count != blob["size"] or "sha256:" + digest.hexdigest() != blob["digest"]:
        raise ValueError("Downloaded model blob failed exact size or SHA256")
    temporary.replace(path)


def prepare_cache():
    os.umask(0o077)
    raw, document, blobs = checked_manifest()
    safe_path(ROOT)
    # Ollama 0.40.5 opens its v2 store even for legacy pinned manifests. Only
    # the fetch companion initializes it; the inference mount stays read-only.
    safe_path(ROOT / "manifests-v2").mkdir(mode=0o700, exist_ok=True)
    target = ROOT / "manifests/registry.ollama.ai/library/funkyfarm-qwen3" / MANIFEST_DIGEST
    known = {target, ROOT / "LICENSE-qwen3.txt", ROOT / "provenance.json"}
    for blob in blobs:
        path = ROOT / "blobs" / blob["digest"].replace(":", "-")
        known.update((path, path.with_name(path.name + ".pending")))
    # Refuse foreign/special entries instead of filling or cleaning their disk.
    total = 0
    for directory, folders, files in os.walk(ROOT, followlinks=False):
        for name in folders + files:
            path = safe_path(Path(directory) / name)
            details = path.lstat()
            if not (stat.S_ISDIR(details.st_mode) or stat.S_ISREG(details.st_mode)):
                raise ValueError("Nonregular model cache entry")
            if path.is_file():
                if path not in known:
                    raise ValueError("Unrecognized model cache entry; no cleanup attempted")
                total += path.stat().st_size
    if total > MAX_CACHE_BYTES:
        raise ValueError("Model cache exceeds 3 GiB; operator review required")
    for blob in blobs:
        download_blob(blob)
    license_blob = next(blob for blob in document["layers"] if blob["mediaType"] == "application/vnd.ollama.image.license")
    license_bytes = (ROOT / "blobs" / license_blob["digest"].replace(":", "-")).read_bytes()
    if b"Apache License" not in license_bytes or b"Version 2.0" not in license_bytes:
        raise ValueError("Expected Apache 2.0 model license")
    provenance = {"model": ALIAS, "manifest_digest": "sha256:" + MANIFEST_DIGEST,
                  "official_source": "https://ollama.com/library/qwen3:4b",
                  "model_license": "Apache-2.0", "total_blob_bytes": TOTAL_BYTES,
                  "all_blob_hashes_verified": True, "cloud_disabled": True}
    # The inference server can see this alias only after every blob verifies.
    if target.exists():
        if safe_path(target).read_bytes() != raw:
            raise ValueError("Existing pinned alias differs; no overwrite attempted")
    else:
        publish(target, raw)
    for name, content in (("LICENSE-qwen3.txt", license_bytes),
                          ("provenance.json", (json.dumps(provenance, indent=2) + "\n").encode())):
        path = ROOT / name
        if not path.exists():
            publish(path, content)
    print("Pinned local model cache verified; Apache 2.0 license retained.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("serve", "fetch"))
    mode = parser.parse_args().mode
    if mode == "serve":
        os.execv("/usr/bin/ollama", ["ollama", "serve"])
    try:
        prepare_cache()
    except Exception as error:
        # Do not print response bodies, signed redirect URLs or farmer content.
        print("Pinned local model cache unavailable: " + type(error).__name__ +
              ". Farmer API remains available; operator review required.", flush=True)
    # Companion remains running so asynchronous model caching is not a false
    # gate on the farmer API. Chat readiness checks the exact alias and digest.
    while True:
        time.sleep(60)


if __name__ == "__main__":
    main()
