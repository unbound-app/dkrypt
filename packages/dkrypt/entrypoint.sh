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
bridge_socket=${DEVICE_BRIDGE_SOCKET:-/run/dkrypt/device-bridge.sock}
bridge_restart_delay=1
bridge_restart_max_delay=30
bridge_started_at=$(date +%s)

stop_process() {
  process_pid=$1
  if [ -n "$process_pid" ] && kill -0 "$process_pid" 2>/dev/null; then
    kill "$process_pid" 2>/dev/null || true
    wait "$process_pid" 2>/dev/null || true
  fi
}

shutdown() {
  stop_process "${api_pid:-}"
  stop_process "${bridge_pid:-}"
}

handle_signal() {
  trap - EXIT TERM INT
  shutdown
  exit 0
}

trap handle_signal TERM INT
trap shutdown EXIT

while kill -0 "$api_pid" 2>/dev/null; do
  if ! kill -0 "$bridge_pid" 2>/dev/null; then
    wait "$bridge_pid" 2>/dev/null || true
    printf '%s\n' 'device bridge exited; restarting with bounded backoff' >&2
    sleep "$bridge_restart_delay"
    /usr/local/bin/dkrypt-device-bridge &
    bridge_pid=$!
    bridge_started_at=$(date +%s)
    if [ "$bridge_restart_delay" -lt "$bridge_restart_max_delay" ]; then
      bridge_restart_delay=$((bridge_restart_delay * 2))
      if [ "$bridge_restart_delay" -gt "$bridge_restart_max_delay" ]; then
        bridge_restart_delay=$bridge_restart_max_delay
      fi
    fi
  elif [ ! -S "$bridge_socket" ]; then
    bridge_now=$(date +%s)
    bridge_uptime=$((bridge_now - bridge_started_at))
    if [ "$bridge_uptime" -ge "$bridge_restart_max_delay" ]; then
      printf '%s\n' 'device bridge socket did not become ready; restarting' >&2
      kill "$bridge_pid" 2>/dev/null || true
      wait "$bridge_pid" 2>/dev/null || true
      bridge_restart_delay=1
      bridge_started_at=$(date +%s)
      /usr/local/bin/dkrypt-device-bridge &
      bridge_pid=$!
    fi
  else
    bridge_uptime=$(($(date +%s) - bridge_started_at))
    if [ "$bridge_uptime" -ge "$bridge_restart_max_delay" ]; then
      bridge_restart_delay=1
    fi
  fi
  sleep 1
done

api_status=0
wait "$api_pid" || api_status=$?
exit "$api_status"
