#!/usr/bin/env python3
"""Print the --dart-define flags that turn on Firebase push for one app.

Usage: firebase_defines.py <path to google-services.json> <android package name>

Reads the file Firebase gives you for an Android app. If it is missing, prints nothing and the
app is built without push notifications. These values identify the app and are not secrets.
"""
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
package = sys.argv[2]
if not path.exists():
    sys.exit(0)
d = json.loads(path.read_text())
client = next(c for c in d["client"] if c["client_info"]["android_client_info"]["package_name"] == package)
values = {
    "FIREBASE_API_KEY": client["api_key"][0]["current_key"],
    "FIREBASE_APP_ID": client["client_info"]["mobilesdk_app_id"],
    "FIREBASE_PROJECT_ID": d["project_info"]["project_id"],
    "FIREBASE_SENDER_ID": d["project_info"]["project_number"],
}
print(" ".join(f"--dart-define={k}={v}" for k, v in values.items()))
