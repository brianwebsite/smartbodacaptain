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

# Lets the app ask Android whether a phone app exists for "tel:" links (the Call buttons).
if "android.intent.action.DIAL" not in xml:
    queries = """    <queries>
        <intent>
            <action android:name="android.intent.action.DIAL"/>
            <data android:scheme="tel"/>
        </intent>
    </queries>
"""
    xml = xml.replace("<application", queries + "    <application", 1)

xml = re.sub(r'android:label="[^"]*"', f'android:label="{label}"', xml, count=1)

if api_url.startswith("http://") and "usesCleartextTraffic" not in xml:
    xml = xml.replace("<application", '<application\n        android:usesCleartextTraffic="true"', 1)

manifest.write_text(xml)

# Android's release "lint vital" check crashes inside some plugins' Java code
# (seen with google_sign_in_android). It is a style checker, not needed to
# build a working APK, so switch it off for every sub-project.
root_kts = app / "android" / "build.gradle.kts"
root_groovy = app / "android" / "build.gradle"
if root_kts.exists():
    root_kts.write_text(root_kts.read_text() + """
subprojects {
    tasks.configureEach {
        if (name.startsWith("lintVital") || name.startsWith("lintAnalyze")) {
            enabled = false
        }
    }
}
""")
elif root_groovy.exists():
    root_groovy.write_text(root_groovy.read_text() + """
subprojects {
    tasks.configureEach { t ->
        if (t.name.startsWith("lintVital") || t.name.startsWith("lintAnalyze")) {
            t.enabled = false
        }
    }
}
""")
else:
    sys.exit("No root android/build.gradle(.kts) found to patch")

print(f"Prepared {app}: label={label!r}, api={api_url}")
print(manifest.read_text())
