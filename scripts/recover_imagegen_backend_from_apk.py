#!/usr/bin/env python3
"""Restore the exact ImageGen 0.8.4 backend from the known-good Android APK artifact."""
from __future__ import annotations
import hashlib, json, os, shutil, sys, tempfile, zipfile
from pathlib import Path, PurePosixPath

APK_PREFIX = "assets/imagegen-backend/"

def fail(message: str) -> None:
    raise SystemExit("recover-imagegen-backend-from-apk: " + message)

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def main() -> None:
    if len(sys.argv) != 4:
        fail("usage: recover_imagegen_backend_from_apk.py APK DESTINATION RECOVERY_MANIFEST")
    apk, destination, manifest_path = map(Path, sys.argv[1:])
    if not apk.is_file():
        fail("source APK is missing: " + str(apk))
    recovery = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = recovery.get("files")
    patches = recovery.get("launcherPatches")
    if recovery.get("backendVersion") != "0.8.4" or len(expected or {}) != 42 or len(patches or []) != 19:
        fail("recovery manifest does not describe the expected 42-file/19-patch baseline")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="imagegen-apk-recovery-", dir=destination.parent))
    try:
        with zipfile.ZipFile(apk) as bundle:
            try:
                embedded = json.loads(bundle.read(APK_PREFIX + "launcher-bundle.json"))
            except KeyError:
                fail("APK has no embedded launcher-bundle.json")
            for key in ("backendVersion", "sourceCommit", "sourceArchiveSha256", "fileCount", "totalBytes", "files", "launcherPatches"):
                if embedded.get(key) != recovery.get(key):
                    fail("APK provenance mismatch for " + key)
            for relative, expected_hash in sorted(expected.items()):
                rel = PurePosixPath(relative)
                if rel.is_absolute() or ".." in rel.parts:
                    fail("unsafe manifest path: " + relative)
                try:
                    data = bundle.read(APK_PREFIX + relative)
                except KeyError:
                    fail("APK backend file missing: " + relative)
                actual = sha(data)
                if actual != expected_hash:
                    fail("APK backend SHA-256 mismatch: " + relative + " expected=" + expected_hash + " actual=" + actual)
                target = staging.joinpath(*rel.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            total = sum(p.stat().st_size for p in staging.rglob("*") if p.is_file())
            count = sum(1 for p in staging.rglob("*") if p.is_file())
            if count != 42 or total != recovery["totalBytes"]:
                fail(f"extracted backend dimensions mismatch: files={count} bytes={total}")
            (staging / "launcher-bundle.json").write_bytes(bundle.read(APK_PREFIX + "launcher-bundle.json"))
        if destination.exists():
            shutil.rmtree(destination)
        os.replace(staging, destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    print(f"Recovered exact ImageGen 0.8.4 from APK: files={count} bytes={total}; 42/42 SHA-256 matched; launcherPatches=19/19")

if __name__ == "__main__":
    main()
