#!/bin/sh
set -e

mkdir -p /root/.android
printf '%s' "$ADBKEY" > /root/.android/adbkey
chmod 600 /root/.android/adbkey
adb pubkey /root/.android/adbkey > /root/.android/adbkey.pub

echo "Keys written. Connecting to $ADB_TARGET..."
MAX_ATTEMPTS="${ADB_CONNECT_MAX_ATTEMPTS:-60}"
SLEEP_SECS="${ADB_CONNECT_RETRY_SECONDS:-2}"
ATTEMPT=1

while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
  if adb connect "$ADB_TARGET" >/dev/null 2>&1; then
    echo "ADB connected to $ADB_TARGET on attempt $ATTEMPT/$MAX_ATTEMPTS"
    break
  fi

  echo "[$ATTEMPT/$MAX_ATTEMPTS] emulator not ready at $ADB_TARGET; retrying in ${SLEEP_SECS}s..."
  ATTEMPT=$((ATTEMPT + 1))
  sleep "$SLEEP_SECS"
done

if [ "$ATTEMPT" -gt "$MAX_ATTEMPTS" ]; then
  echo "Failed to connect to $ADB_TARGET after $MAX_ATTEMPTS attempts"
  exit 1
fi

adb -s "$ADB_TARGET" wait-for-device

echo "Connected. Disabling background noise..."
adb -s "$ADB_TARGET" shell svc wifi disable || true
adb -s "$ADB_TARGET" shell svc data disable || true

echo "Ready. Starting server..."
# Start Flask app via gunicorn, binding to all interfaces on port 5000.
# Use 4 sync workers so that long-lived /screenrecord streaming requests do not
# block concurrent /input-event, /frame, or /device-info calls.  The timeout is
# set to 300 s (well above the 180 s screenrecord time-limit) to prevent gunicorn
# from killing workers that are actively streaming a response.
# Gunicorn sync workers are separate forked processes with independent memory
# spaces, so there is no shared mutable state between them; all per-request state
# (ADB subprocesses, file handles) is created locally within each worker process.
exec gunicorn -b 0.0.0.0:5000 --workers 4 --timeout 300 app:app
