#!/bin/sh
set -e

mkdir -p /root/.android
printf '%s' "$ADBKEY" > /root/.android/adbkey
chmod 600 /root/.android/adbkey
adb pubkey /root/.android/adbkey > /root/.android/adbkey.pub

echo "Keys written. Connecting to $ADB_TARGET..."
adb connect "$ADB_TARGET"
sleep 5
adb -s "$ADB_TARGET" wait-for-device

echo "Connected. Disabling background noise..."
adb -s "$ADB_TARGET" shell svc wifi disable || true
adb -s "$ADB_TARGET" shell svc data disable || true

echo "Ready. Starting server..."
# Start Flask app via gunicorn, binding to all interfaces on port 5000
exec gunicorn -b 0.0.0.0:5000 app:app
