"""Assert the drawer geometry probed from the iOS Simulator (see check-ios.sh)."""
import sys
import json

raw = sys.stdin.read().strip()
if raw.startswith('"') and raw.endswith('"'):
    raw = raw[1:-1]
raw = raw.replace('\\"', '"')
if not raw:
    print("  no probe output — did the app launch?")
    sys.exit(1)

d = json.loads(raw)
VH = d["innerH"]
INSET = float(str(d["saBottom"]).replace("px", "") or 0)

fails = 0


def check(name, ok, detail):
    global fails
    if not ok:
        fails += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}\n        {detail}")


check(
    "safe-area insets resolved",
    INSET >= 34,
    f"--sa-top={d['saTop']} --sa-bottom={d['saBottom']} (app-vh={d['appVh'] or 'unset'})",
)
btn, sb = d["btn"], d["sidebar"]
check(
    "drawer not overflowing",
    d["sbScrollH"] <= d["sbClientH"],
    f"scrollHeight={d['sbScrollH']} clientHeight={d['sbClientH']}",
)
check("New chat button full height", btn["h"] >= 40, f"button height={btn['h']}px")
check(
    "New chat clear of home indicator",
    VH - btn["bottom"] >= INSET,
    f"{VH - btn['bottom']}px from screen bottom (need >= {INSET:.0f})",
)
check(
    "button inside the drawer (not clipped)",
    btn["bottom"] <= sb["bottom"],
    f"button bottom={btn['bottom']} drawer bottom={sb['bottom']}",
)

print(f"\n{5 - fails}/5 checks passed")
sys.exit(1 if fails else 0)
