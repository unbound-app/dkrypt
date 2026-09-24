#!/bin/sh
set -eu

if [ -z "${DEVICE_BRIDGE_SECRET:-}" ]; then
  secret_file=${DEVICE_BRIDGE_SECRET_FILE:-/data/state/device-bridge.secret}
  if [ -s "$secret_file" ]; then
    DEVICE_BRIDGE_SECRET=$(tr -d '\n' < "$secret_file")
  else
    DEVICE_BRIDGE_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n')
    umask 077
    mkdir -p "$(dirname "$secret_file")"
    printf '%s\n' "$DEVICE_BRIDGE_SECRET" > "$secret_file"
  fi
  export DEVICE_BRIDGE_SECRET
fi

/usr/local/bin/dkrypt-device-bridge &
bridge_pid=$!
bun src/server.ts &
api_pid=$!

shutdown() {
  kill "$api_pid" "$bridge_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  wait "$bridge_pid" 2>/dev/null || true
}

trap shutdown TERM INT EXIT

while kill -0 "$api_pid" 2>/dev/null; do
  if ! kill -0 "$bridge_pid" 2>/dev/null; then
    wait "$bridge_pid" 2>/dev/null || true
    /usr/local/bin/dkrypt-device-bridge &
    bridge_pid=$!
  fi
  sleep 1
done

exit 1
