use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command as StdCommand,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    process::Command,
    time::{sleep, timeout},
};
use uuid::Uuid;

const SECRET: &str = "supervisor-integration-secret-long-enough";

async fn wait_for_file(path: &Path) -> Result<(), String> {
    timeout(Duration::from_secs(3), async {
        while !path.exists() {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| format!("{} did not appear", path.display()))
}

async fn wait_for_counter(path: &Path, minimum: usize) -> Result<(), String> {
    timeout(Duration::from_secs(3), async {
        loop {
            if fs::read_to_string(path).is_ok_and(|value| value.len() >= minimum) {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| format!("{} did not reach {minimum}", path.display()))
}

async fn request_capabilities(socket_path: &Path) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket_path)
        .await
        .map_err(|value| value.to_string())?;
    let request_id = Uuid::new_v4().to_string();
    let body = serde_json::to_vec(&json!({
        "version": 1,
        "requestId": request_id,
        "auth": SECRET,
        "operation": "capabilities"
    }))
    .map_err(|value| value.to_string())?;
    stream
        .write_u32(body.len() as u32)
        .await
        .map_err(|value| value.to_string())?;
    stream
        .write_all(&body)
        .await
        .map_err(|value| value.to_string())?;
    let length = stream.read_u32().await.map_err(|value| value.to_string())? as usize;
    let mut response = vec![0; length];
    stream
        .read_exact(&mut response)
        .await
        .map_err(|value| value.to_string())?;
    serde_json::from_slice(&response).map_err(|value| value.to_string())
}

#[tokio::test]
async fn rpc_remains_available_before_mux_readiness_and_across_mux_restarts() {
    let directory = PathBuf::from(format!("/tmp/dkrypt-bridge-process-{}", Uuid::new_v4()));
    let rpc_socket = directory.join("device-bridge.sock");
    let mux_socket = directory.join("netmuxd.sock");
    let pairing_store = directory.join("pairing");
    let restart_counter = pairing_store.join("restarts");
    let first_start = pairing_store.join("first-start");
    let netmuxd = directory.join("netmuxd-fixture");
    fs::create_dir_all(&pairing_store).expect("pairing store should be created");
    fs::write(
        &netmuxd,
        "#!/bin/sh\nset -eu\nsocket=\nstore=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"--socket-path\" ]; then socket=$2; shift 2; elif [ \"$1\" = \"--plist-storage\" ]; then store=$2; shift 2; else shift; fi\ndone\nprintf x >> \"$store/restarts\"\ncount=$(wc -c < \"$store/restarts\")\nif [ \"$count\" -eq 1 ]; then : > \"$store/first-start\"; sleep 0.5; exit 1; fi\n: > \"$socket\"\nsleep 0.5\n",
    )
    .expect("fixture executable should be written");
    fs::set_permissions(&netmuxd, fs::Permissions::from_mode(0o700))
        .expect("fixture executable should be executable");

    let bridge_binary = std::env::var("CARGO_BIN_EXE_dkrypt-device-bridge")
        .expect("Cargo should provide the device bridge binary path");
    let mut bridge = Command::new(bridge_binary)
        .env("DEVICE_BRIDGE_SOCKET", &rpc_socket)
        .env("DEVICE_MUX_SOCKET", &mux_socket)
        .env("DEVICE_PAIRING_STORE", &pairing_store)
        .env("DEVICE_BRIDGE_SECRET", SECRET)
        .env("NETMUXD_BIN", &netmuxd)
        .spawn()
        .expect("device bridge should start");

    let result: Result<(), String> = async {
        wait_for_file(&rpc_socket).await?;
        wait_for_file(&first_start).await?;

        let before_mux_ready = request_capabilities(&rpc_socket).await?;
        if before_mux_ready["ok"] != Value::Bool(true)
            || before_mux_ready["result"]["protocolVersion"] != 1
        {
            return Err("bridge RPC was not available while netmuxd was starting".to_string());
        }

        wait_for_counter(&restart_counter, 2).await?;
        let after_mux_restart = request_capabilities(&rpc_socket).await?;
        if after_mux_restart["ok"] != Value::Bool(true)
            || after_mux_restart["result"]["protocolVersion"] != 1
        {
            return Err("bridge RPC was not available after netmuxd restarted".to_string());
        }
        Ok(())
    }
    .await;

    if let Some(pid) = bridge.id() {
        let _ = StdCommand::new("/bin/kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
    }
    if timeout(Duration::from_secs(3), bridge.wait())
        .await
        .is_err()
    {
        let _ = bridge.kill().await;
        let _ = bridge.wait().await;
    }
    let _ = fs::remove_dir_all(&directory);
    result.expect("bridge should survive netmuxd start and restart");
}
