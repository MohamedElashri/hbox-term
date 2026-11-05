#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  x11)
    export GDK_BACKEND=x11
    xvfb-run -a -s '-screen 0 1440x900x24' dbus-run-session -- python3 tools/native-gui-smoke.py src-tauri/target/debug/ternway
    ;;
  wayland)
    export XDG_RUNTIME_DIR="$RUNNER_TEMP/ternway-wayland-runtime"
    mkdir -m 700 "$XDG_RUNTIME_DIR"
    export WAYLAND_DISPLAY=wayland-ternway
    export GDK_BACKEND=wayland
    unset DISPLAY
    weston --backend=headless-backend.so --renderer=pixman --socket="$WAYLAND_DISPLAY" --idle-time=0 --width=1440 --height=900 --no-config > "$RUNNER_TEMP/weston.log" 2>&1 &
    compositor_pid=$!
    trap 'kill "$compositor_pid" || true' EXIT
    for attempt in $(seq 1 100); do
      [[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]] && break
      sleep 0.1
    done
    test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
    dbus-run-session -- python3 tools/native-gui-smoke.py src-tauri/target/debug/ternway
    ;;
  *) echo 'Choose x11 or wayland.' >&2; exit 1 ;;
esac
