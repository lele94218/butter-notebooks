#!/bin/bash
# Verify the mobile layout in a REAL standalone WebKit environment.
#
#   ./scripts/check-ios.sh [url]
#
# Playwright (Chromium and WebKit alike) renders desktop WebKit in a phone-sized
# viewport and never reproduced the clipped drawer footer. This instead builds a
# tiny full-screen WKWebView app, installs it in the iOS Simulator, and probes
# the live geometry — the same engine, safe areas and standalone flags as the
# home-screen app on a real iPhone.
#
# Requires: Xcode + an iOS Simulator runtime.
set -e

# Site + token come from the environment or the repo's gitignored config —
# never hard-coded, since the URL carries the API token.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$REPO/deploy.env" ] && . "$REPO/deploy.env"
[ -z "$API_TOKEN" ] && [ -f "$REPO/backend/.env" ] && \
  API_TOKEN=$(grep -E "^API_TOKEN=" "$REPO/backend/.env" | cut -d= -f2- | tr -d "\"'")
: "${SITE_URL:?set SITE_URL (e.g. in deploy.env)}"
: "${API_TOKEN:?set API_TOKEN}"
URL="${1:-$SITE_URL}"
BUNDLE=dev.butternotebooks.probe
APPDIR="$(cd "$(dirname "$0")" && pwd)/../.ios-probe"
DEVNAME="butter-test"

# Reuse the device if it already exists
DEV=$(xcrun simctl list devices 2>/dev/null | grep "$DEVNAME" | grep -oE '[0-9A-F-]{36}' | head -1)
if [ -z "$DEV" ]; then
  RUNTIME=$(xcrun simctl list runtimes 2>/dev/null | grep -oE 'com.apple.CoreSimulator.SimRuntime.iOS-[0-9-]+' | tail -1)
  DEVTYPE=$(xcrun simctl list devicetypes 2>/dev/null | grep -oE 'com.apple.CoreSimulator.SimDeviceType.iPhone-1[5-9]-Pro' | tail -1)
  DEV=$(xcrun simctl create "$DEVNAME" "$DEVTYPE" "$RUNTIME")
  echo "created simulator $DEV"
fi
xcrun simctl boot "$DEV" 2>/dev/null || true
sleep 3

xcrun simctl terminate "$DEV" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$DEV" "$APPDIR/BWK.app"
OUT=$(mktemp)
SIMCTL_CHILD_BWK_URL="$URL" SIMCTL_CHILD_BWK_TOKEN="$API_TOKEN" xcrun simctl launch --console-pty "$DEV" "$BUNDLE" > "$OUT" 2>&1 &
LAUNCH_PID=$!
for _ in $(seq 1 30); do grep -q PROBE_RESULT "$OUT" && break; sleep 1; done
kill $LAUNCH_PID 2>/dev/null || true
grep -m1 "PROBE_RESULT" "$OUT" \
  | sed 's/^PROBE_RESULT: //; s/ err=.*$//' \
  | python3 "$(dirname "$0")/_ios-assert.py"
