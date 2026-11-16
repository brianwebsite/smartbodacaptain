#!/usr/bin/env python3
"""Generate and patch the Android project for one Flutter app.

Usage: prepare_android.py <app-dir> <project-name> <app-label> <api-base-url>

The repository keeps only the Dart code. This script asks `flutter create` to
produce a fresh, SDK-matching android/ folder in a temp directory, copies it
into the app, and patches AndroidManifest.xml (permissions, label, cleartext
only for http:// API addresses).
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

app_dir, project, label, api_url = sys.argv[1:5]
app = Path(app_dir).resolve()

with tempfile.TemporaryDirectory() as tmp:
    subprocess.run(
        ["flutter", "create", "--org", "ug.smartboda", "--project-name", project,
         "--platforms", "android", "--no-pub", project],
        cwd=tmp, check=True,
    )
    src = Path(tmp) / project / "android"
    dst = app / "android"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)

manifest = app / "android" / "app" / "src" / "main" / "AndroidManifest.xml"
xml = manifest.read_text()

permissions = """    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
"""
if "android.permission.INTERNET" not in xml:
    xml = xml.replace("<application", permissions + "    <application", 1)

xml = re.sub(r'android:label="[^"]*"', f'android:label="{label}"', xml, count=1)

if api_url.startswith("http://") and "usesCleartextTraffic" not in xml:
    xml = xml.replace("<application", '<application\n        android:usesCleartextTraffic="true"', 1)

manifest.write_text(xml)
print(f"Prepared {app}: label={label!r}, api={api_url}")
print(manifest.read_text())
