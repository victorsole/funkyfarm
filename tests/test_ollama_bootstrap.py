"""Pinned cache and isolation contracts; never download model weights in CI."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("ollama_bootstrap", ROOT / "containers/ollama_bootstrap.py")
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class Response(io.BytesIO):
    status = 200
    url = "https://registry.ollama.ai/reviewed-public-blob"


class ModelCacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.content = b"reviewed model fixture"
        self.blob = {"digest": "sha256:" + hashlib.sha256(self.content).hexdigest(), "size": len(self.content)}
        self.path = self.root / "blobs" / self.blob["digest"].replace(":", "-")

    def opener(self, content=None):
        return SimpleNamespace(open=lambda *_args, **_kwargs: Response(self.content if content is None else content))

    def download(self, content=None):
        with patch.object(bootstrap.shutil, "disk_usage", return_value=SimpleNamespace(free=20 * 1024**3)):
            bootstrap.download_blob(self.blob, root=self.root, opener=self.opener(content))

    def test_official_manifest_has_exact_identity_size_and_license(self):
        raw, manifest, blobs = bootstrap.checked_manifest()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), bootstrap.MANIFEST_DIGEST)
        self.assertEqual(sum(blob["size"] for blob in blobs), 2497293931)
        self.assertEqual(manifest["layers"][0]["digest"], "sha256:3e4cb14174460404e7a233e531675303b2fbf7749c02f91864fe311ab6344e4f")
        self.assertTrue(any(x["mediaType"] == "application/vnd.ollama.image.license" for x in blobs))

    def test_cache_initializes_v2_directory_before_fetch_without_publishing_alias(self):
        previous_umask = os.umask(0o077)
        self.addCleanup(os.umask, previous_umask)
        with patch.object(bootstrap, "ROOT", self.root), patch.object(
            bootstrap, "download_blob", side_effect=RuntimeError("Stop before public weight download")
        ) as download:
            with self.assertRaisesRegex(RuntimeError, "Stop before public weight download"):
                bootstrap.prepare_cache()
        download.assert_called_once_with(bootstrap.checked_manifest()[2][0])
        store = self.root / "manifests-v2"
        self.assertTrue(store.is_dir())
        self.assertFalse(store.is_symlink())
        self.assertEqual(list(store.iterdir()), [])
        self.assertFalse((self.root / "manifests").exists())

    def test_modified_manifest_is_rejected(self):
        source = self.root / "manifest.json"
        source.write_text('{"schemaVersion":2}')
        with self.assertRaisesRegex(ValueError, "identity"):
            bootstrap.checked_manifest(source)

    def test_exact_blob_is_published_only_after_size_and_hash_match(self):
        self.download()
        self.assertEqual(self.path.read_bytes(), self.content)
        self.assertFalse(self.path.with_name(self.path.name + ".pending").exists())

    def test_hash_mismatch_does_not_publish(self):
        with self.assertRaisesRegex(ValueError, "SHA256"):
            self.download(b"x" * len(self.content))
        self.assertFalse(self.path.exists())

    def test_short_or_oversize_response_does_not_publish(self):
        for content in (b"short", self.content + b"extra"):
            with self.subTest(size=len(content)), self.assertRaises(ValueError):
                self.download(content)
            self.assertFalse(self.path.exists())

    def test_verified_cached_blob_does_not_reach_network(self):
        self.download()
        opener = SimpleNamespace(open=lambda *_a, **_k: self.fail("Cache reuse must not download"))
        bootstrap.download_blob(self.blob, root=self.root, opener=opener)

    def test_corrupt_existing_blob_is_never_overwritten(self):
        self.path.parent.mkdir()
        self.path.write_bytes(b"x" * len(self.content))
        with self.assertRaisesRegex(ValueError, "no overwrite"):
            self.download()
        self.assertEqual(self.path.read_bytes(), b"x" * len(self.content))

    def test_low_disk_refuses_download_without_cleanup(self):
        opener = SimpleNamespace(open=lambda *_a, **_k: self.fail("Low disk must not download"))
        with patch.object(bootstrap.shutil, "disk_usage", return_value=SimpleNamespace(free=1)), self.assertRaisesRegex(ValueError, "8 GiB"):
            bootstrap.download_blob(self.blob, root=self.root, opener=opener)

    def test_path_escape_and_symlink_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "leaves"):
            bootstrap.safe_path(self.root.parent / "foreign", self.root)
        link = self.root / "link"
        try:
            link.symlink_to(self.root.parent, target_is_directory=True)
        except OSError:
            self.skipTest("Creating symlinks unavailable on this platform")
        with self.assertRaisesRegex(ValueError, "symbolic"):
            bootstrap.safe_path(link / "foreign", self.root)

    def test_release_uses_a_separate_cpu_component(self):
        release = json.loads((ROOT / ".github/hetzner-release.json").read_text())
        component = next(c for c in release["release"]["components"] if c["name"] == "ollama")
        self.assertEqual(component["dockerfile"], "containers/ollama.Dockerfile")


if __name__ == "__main__":
    unittest.main()
