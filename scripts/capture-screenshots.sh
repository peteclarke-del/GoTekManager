#!/usr/bin/env bash
#
# Captures the in-app help screenshots.
#
# Builds throwaway fixture folders, starts a tiny capture server, launches the
# real application with the capture harness enabled, and photographs the window
# as the harness clicks through the guided flow. Run once per theme:
#
#   scripts/capture-screenshots.sh light
#   scripts/capture-screenshots.sh dark
#
# Requirements: ImageMagick (`import`), `xwininfo`, and an X11 or XWayland
# display. The application is forced onto X11 so the window can be captured;
# GNOME's Wayland session does not allow capturing another window directly.
set -euo pipefail

THEME="${1:-light}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/gotek-capture"
OUT="${CAPTURE_OUT_DIR:-$ROOT/public/help/$THEME}"
PORT="${CAPTURE_PORT:-8791}"
WINDOW_TITLE="GoTek Manager"

# The Snap-packaged VS Code exports a wrapper environment that makes any native
# GTK/WebKit launch fail with a libc symbol error. Strip it.
unset LD_LIBRARY_PATH GTK_PATH GTK_EXE_PREFIX GTK_IM_MODULE_FILE \
      GIO_MODULE_DIR GSETTINGS_SCHEMA_DIR LOCPATH \
      GDK_PIXBUF_MODULEDIR GDK_PIXBUF_MODULE_FILE \
      SNAP SNAP_ARCH SNAP_COMMON SNAP_CONTEXT SNAP_COOKIE SNAP_DATA SNAP_EUID \
      SNAP_INSTANCE_NAME SNAP_LAUNCHER_ARCH_TRIPLET SNAP_LIBRARY_PATH SNAP_NAME \
      SNAP_REAL_HOME SNAP_REVISION SNAP_UID SNAP_USER_COMMON SNAP_USER_DATA SNAP_VERSION
if [ -n "${XDG_DATA_DIRS_VSCODE_SNAP_ORIG:-}" ]; then
  export XDG_DATA_DIRS="$XDG_DATA_DIRS_VSCODE_SNAP_ORIG"
fi
# WebKitGTK must be an X11 client for `import` to be able to see it.
export GDK_BACKEND=x11
# Give the run its own application data directory. A screenshot must never show
# a real library, and a capture must never touch one. Relying on the default is
# not safe: a Snap-packaged terminal silently redirects XDG_DATA_HOME, so the
# location would be unpredictable, and outside that terminal it would be real.
export XDG_DATA_HOME="$WORK/appdata"
export PATH="$HOME/.cargo/bin:$PATH"

echo "==> Building fixtures in $WORK"
rm -rf "$WORK"
mkdir -p "$WORK/Retro Library/BBC" "$WORK/Retro Library/Acornsoft" "$WORK/GOTEK/BBC" "$WORK/CPC 6128"

# Plausible 200K single-sided DFS images. Content is arbitrary; only the
# extension, the size, and the name matter to the application.
make_image() { head -c "${2:-204800}" /dev/urandom > "$1"; }

for title in "Elite (1984)" "Chuckie Egg" "Repton 2" "Exile" "Revs"; do
  make_image "$WORK/Retro Library/BBC/$title.ssd"
done
make_image "$WORK/Retro Library/Acornsoft/Aviator.ssd"
make_image "$WORK/Retro Library/Acornsoft/Planetoid.dsd" 409600

# Firmware evidence, so the profile shows detected FlashFloppy.
printf 'interface = shugart\nhost = acorn\n' > "$WORK/GOTEK/FF.CFG"
# One title already present and identical, so the plan shows an unchanged file.
cp "$WORK/Retro Library/BBC/Chuckie Egg.ssd" "$WORK/GOTEK/BBC/Chuckie Egg.ssd"
# One title only on the destination, so the current load is not just our own.
make_image "$WORK/GOTEK/BBC/Snapper.ssd"
# A second destination, so the profile list is not a single lonely entry.
make_image "$WORK/CPC 6128/Head Over Heels.dsk" 194816

mkdir -p "$OUT"
rm -f "$OUT"/*.png

echo "==> Starting capture server on 127.0.0.1:$PORT"
CAPTURE_OUT="$OUT" CAPTURE_TITLE="$WINDOW_TITLE" CAPTURE_PORT="$PORT" \
  python3 "$ROOT/scripts/capture-server.py" &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  if [ -n "${APP_PID:-}" ]; then
    kill -- "-$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> Launching the application (theme: $THEME)"
cd "$ROOT"
VITE_CAPTURE=1 \
VITE_CAPTURE_LIBRARY="$WORK/Retro Library" \
VITE_CAPTURE_DESTINATION="$WORK/GOTEK" \
VITE_CAPTURE_DESTINATION_2="$WORK/CPC 6128" \
VITE_CAPTURE_ENDPOINT="http://127.0.0.1:$PORT" \
VITE_CAPTURE_THEME="$THEME" \
  setsid npm run tauri dev > "$WORK/app.log" 2>&1 &
APP_PID=$!

echo "==> Waiting for the harness to finish"
for _ in $(seq 1 600); do
  [ -f "$OUT/.done" ] && break
  [ -f "$OUT/.failed" ] && break
  sleep 1
done

if [ -f "$OUT/.failed" ]; then
  echo "!! Capture failed: $(cat "$OUT/.failed")" >&2
  tail -30 "$WORK/app.log" >&2
  exit 1
fi
if [ ! -f "$OUT/.done" ]; then
  echo "!! Timed out. Last log lines:" >&2
  tail -30 "$WORK/app.log" >&2
  exit 1
fi
rm -f "$OUT/.done"

echo "==> Optimising"
for image in "$OUT"/*.png; do
  convert "$image" -strip -resize '1100>' -colors 220 "$image"
done

rm -rf "$WORK"
ls -la "$OUT"
echo "==> Done"
