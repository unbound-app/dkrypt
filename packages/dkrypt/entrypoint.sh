#!/bin/sh
set -eu

migrate_shared_volume() {
  volume_dir=$1
  marker=$2
  mkdir -p "$volume_dir"
  if [ ! -e "$marker" ]; then
    chown -R 10001:10001 "$volume_dir"
    find "$volume_dir" -type d -exec chmod 2770 {} +
    find "$volume_dir" -type f -exec chmod g+rw {} +
    touch "$marker"
    chown 0:10001 "$marker"
    chmod 0440 "$marker"
  fi
  chown 0:10001 "$volume_dir"
  chmod 3770 "$volume_dir"
}

state_dir=$(realpath -m "${STATE_DIR:-/data/state}")
artifact_dir=$(realpath -m "${ARTIFACT_DIR:-/data/artifacts}")
case "$state_dir" in /data/*) ;; *) printf '%s\n' 'STATE_DIR must resolve below /data' >&2; exit 1 ;; esac
case "$artifact_dir" in /data/*) ;; *) printf '%s\n' 'ARTIFACT_DIR must resolve below /data' >&2; exit 1 ;; esac
mkdir -p /run/dkrypt /data/tmp "$state_dir" "$artifact_dir"
chown 0:10001 /run/dkrypt /data/tmp
chmod 0710 /run/dkrypt
chmod 1770 /data/tmp
migrate_shared_volume "$state_dir" "$state_dir/.dkrypt-api-access-v1"
migrate_shared_volume "$artifact_dir" "$artifact_dir/.dkrypt-api-access-v1"

pairing_store=$(realpath -m "${DEVICE_PAIRING_STORE:-$state_dir/device-pairing}")
case "$pairing_store" in "$state_dir"/*) ;; *) printf '%s\n' 'DEVICE_PAIRING_STORE must resolve below STATE_DIR' >&2; exit 1 ;; esac
mkdir -p "$pairing_store"
chown -R 0:0 "$pairing_store"
find "$pairing_store" -type d -exec chmod 0700 {} +
find "$pairing_store" -type f -exec chmod 0600 {} +

ssh_key_source=${DEVICE_SSH_KEY_SOURCE:-/device-ssh-key-source}
ssh_key_path=${DEVICE_SSH_KEY_PATH:-/run/dkrypt/device_ssh_key}
if [ -r "$ssh_key_source" ]; then
  install -o 0 -g 10001 -m 0440 "$ssh_key_source" "$ssh_key_path"
fi
mkdir -p /root/.ssh
chown 0:10001 /root /root/.ssh
chmod 0710 /root /root/.ssh
ln -sfn "$ssh_key_path" /root/.ssh/id_ed25519

secret_file=${DEVICE_BRIDGE_SECRET_FILE:-$state_dir/device-bridge.secret}
if [ -z "${DEVICE_BRIDGE_SECRET:-}" ]; then
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
if [ -e "$secret_file" ]; then
  chown 0:0 "$secret_file"
  chmod 0600 "$secret_file"
fi

umask 007
start_device_bridge() {
  setpriv --regid=10001 --clear-groups /usr/local/bin/dkrypt-device-bridge &
  bridge_pid=$!
  bridge_started_at=$(date +%s)
}

start_device_bridge
setpriv --reuid=10001 --regid=10001 --clear-groups bun src/server.ts &
api_pid=$!
bridge_socket=${DEVICE_BRIDGE_SOCKET:-/run/dkrypt/device-bridge.sock}
bridge_restart_delay=1
bridge_restart_max_delay=30

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
    start_device_bridge
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
      start_device_bridge
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
