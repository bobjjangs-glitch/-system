#!/usr/bin/env python3
"""Reject an APK that silently used Expo's unpatched precompiled location AAR."""
import pathlib
import sys
import zipfile

with zipfile.ZipFile(pathlib.Path(sys.argv[1])) as apk:
    dex = [apk.read(name) for name in apk.namelist() if name.startswith("classes") and name.endswith(".dex")]
    for required in (
        b"getForegroundServiceStatusAsync",
        b"expo.modules.location.serviceOptions",
        b"Handled location service start failure",
    ):
        if not any(required in data for data in dex):
            raise SystemExit("APK is missing the native location safety patch: " + required.decode())
    bundle = apk.read("assets/index.android.bundle")
    if b"getForegroundServiceStatusAsync" not in bundle:
        raise SystemExit("APK client does not check the actual native location service state")
print("Verified native location startup patch and client service-state check in APK.")
