#!/usr/bin/env python3
"""Package app source and the prebuilt web UI without machine-local data."""
import hashlib
import pathlib
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
destination = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/workspace/artifacts/bareun-dispatch-cafe24.zip")
if not (root / "dist/index.html").is_file():
    raise SystemExit("Run npm run export:web before creating the server package.")

selected = [
    "package.json", "package-lock.json", "App.tsx", "app.json", "eas.json",
    "tsconfig.json", ".env.example", ".gitignore", "README.md", "render.yaml",
    "src", "server", "deploy", "docs", "dist",
    "scripts/install-cloud.sh", "scripts/package-cafe24.py", "scripts/cloud-android-env.sh", "scripts/setup-cloud-android.py",
]
files = []
for entry in selected:
    path = root / entry
    if not path.exists():
        raise SystemExit(f"Required release input is missing: {entry}")
    files.extend([path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file()))

for path in files:
    relative = path.relative_to(root)
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        raise SystemExit(f"Symlinked release input is not supported: {relative}")
    if path.name.startswith(".env") and path.name != ".env.example":
        raise SystemExit(f"Private environment file cannot be packaged: {relative}")
    if path.suffix in {".key", ".pem", ".p12", ".pfx", ".sqlite", ".db", ".log"} or path.name in {"server.env", "credentials.json"}:
        raise SystemExit(f"Machine-local or private file cannot be packaged: {relative}")
    if any(part in {"node_modules", ".git", ".local", ".expo", "uploads"} for part in relative.parts):
        raise SystemExit(f"Machine-local directory cannot be packaged: {relative}")

destination.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as archive:
    for path in files:
        archive.write(path, "dispatch/" + path.relative_to(root).as_posix())
with zipfile.ZipFile(destination) as archive:
    if archive.testzip() is not None:
        raise SystemExit("Release archive integrity check failed.")
digest = hashlib.sha256(destination.read_bytes()).hexdigest()
destination.with_suffix(destination.suffix + ".sha256").write_text(digest + "  " + destination.name + "\n")
print(f"Created {destination} ({len(files)} files; {destination.stat().st_size:,} bytes)")
