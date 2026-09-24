use idevice::{
    IdeviceService,
    provider::{IdeviceProvider, UsbmuxdProvider},
    services::lockdown::LockdownClient,
    usbmuxd::{UsbmuxdAddr, UsbmuxdConnection, UsbmuxdDevice},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional},
    net::{TcpListener, UnixListener, UnixStream},
    process::{Child, Command},
    sync::{Mutex, Notify},
    time::{sleep, timeout},
};
use uuid::Uuid;

const RPC_VERSION: u16 = 1;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_AGENT_PORT: u16 = 5913;
const DEFAULT_SSH_PORT: u16 = 22;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcRequest {
    version: u16,
    request_id: String,
    auth: String,
    operation: String,
    device_id: Option<String>,
    port: Option<u16>,
    payload: Option<Value>,
    agent_secret: Option<String>,
    deadline_ms: Option<u64>,
    host_id: Option<String>,
    follow: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcError {
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcResponse {
    version: u16,
    request_id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceSummary {
    id: String,
    udid: String,
    device_id: u32,
    transport: String,
}

#[derive(Clone)]
struct CancellationToken {
    cancelled: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl CancellationToken {
    fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    fn cancel(&self) {
        if !self.cancelled.swap(true, Ordering::Release) {
            self.notify.notify_one();
        }
    }

    async fn cancelled(&self) {
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        self.notify.notified().await;
    }
}

struct BridgeState {
    secrets: Vec<String>,
    mux_socket: PathBuf,
    host_id: String,
    tunnels: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    cancellations: Mutex<HashMap<String, CancellationToken>>,
    event_sequence: AtomicU64,
}

impl BridgeState {
    async fn register_cancellation(&self, request_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.cancellations
            .lock()
            .await
            .insert(request_id.to_string(), token.clone());
        token
    }

    async fn remove_cancellation(&self, request_id: &str) {
        self.cancellations.lock().await.remove(request_id);
    }

    async fn cancel_request(&self, request_id: &str) -> bool {
        let token = self.cancellations.lock().await.get(request_id).cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }
}

fn error(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> RpcError {
    RpcError {
        code: code.into(),
        message: message.into(),
        retryable,
    }
}

fn response(request_id: String, result: Value) -> RpcResponse {
    RpcResponse {
        version: RPC_VERSION,
        request_id,
        ok: true,
        result: Some(result),
        error: None,
    }
}

fn failure(request_id: String, rpc_error: RpcError) -> RpcResponse {
    RpcResponse {
        version: RPC_VERSION,
        request_id,
        ok: false,
        result: None,
        error: Some(rpc_error),
    }
}

fn valid_frame_length(length: usize, maximum: usize) -> bool {
    length > 0 && length <= maximum
}

fn bridge_capabilities() -> [&'static str; 14] {
    [
        "list_devices",
        "pair",
        "metadata",
        "agent",
        "remote_command",
        "service_port",
        "open_tunnel",
        "close_tunnel",
        "health",
        "capabilities",
        "events",
        "file_read",
        "file_write",
        "cancel",
    ]
}

fn next_event_sequence(state: &BridgeState) -> u64 {
    state.event_sequence.fetch_add(1, Ordering::Relaxed) + 1
}

fn authorized_secret(secrets: &[String], candidate: &str) -> bool {
    secrets.iter().any(|secret| secret == candidate)
}

fn required_env(name: &str) -> Result<String, RpcError> {
    env::var(name).map_err(|_| error("configuration", format!("missing {name}"), false))
}

fn unix_path(name: &str, default: &str) -> PathBuf {
    PathBuf::from(env::var(name).unwrap_or_else(|_| default.to_string()))
}

fn device_summary(device: UsbmuxdDevice) -> DeviceSummary {
    let transport = match device.connection_type {
        idevice::usbmuxd::Connection::Usb => "usb".to_string(),
        idevice::usbmuxd::Connection::Network(address) => format!("wifi:{address}"),
        idevice::usbmuxd::Connection::Unknown(value) => format!("unknown:{value}"),
    };
    DeviceSummary {
        id: device.udid.clone(),
        udid: device.udid,
        device_id: device.device_id,
        transport,
    }
}

async fn mux_connection(state: &BridgeState) -> Result<UsbmuxdConnection, RpcError> {
    UsbmuxdAddr::UnixSocket(state.mux_socket.to_string_lossy().to_string())
        .connect(0)
        .await
        .map_err(|value| {
            error(
                "mux_unavailable",
                format!("could not connect to netmuxd: {value}"),
                true,
            )
        })
}

async fn find_device(
    state: &BridgeState,
    id: &str,
) -> Result<(UsbmuxdDevice, UsbmuxdAddr), RpcError> {
    let addr = UsbmuxdAddr::UnixSocket(state.mux_socket.to_string_lossy().to_string());
    let mut mux = addr.connect(0).await.map_err(|value| {
        error(
            "mux_unavailable",
            format!("could not connect to netmuxd: {value}"),
            true,
        )
    })?;
    let devices = mux.get_devices().await.map_err(|value| {
        error(
            "device_discovery",
            format!("could not list devices: {value}"),
            true,
        )
    })?;
    devices
        .into_iter()
        .find(|device| device.udid == id || format!("id:{}", device.udid) == id)
        .map(|device| (device, addr))
        .ok_or_else(|| {
            error(
                "device_not_found",
                format!("device {id} is not connected"),
                true,
            )
        })
}

async fn provider_for(
    state: &BridgeState,
    id: &str,
) -> Result<(UsbmuxdProvider, UsbmuxdAddr), RpcError> {
    let (device, addr) = find_device(state, id).await?;
    Ok((
        device.to_provider(addr.clone(), format!("dkrypt-device-{id}")),
        addr,
    ))
}

async fn read_value(lockdown: &mut LockdownClient, key: &str) -> Option<String> {
    lockdown
        .get_value(Some(key), None)
        .await
        .ok()
        .and_then(|value| value.as_string().map(ToString::to_string))
}

async fn list_devices(state: &BridgeState) -> Result<Value, RpcError> {
    let mut mux = mux_connection(state).await?;
    let devices = mux.get_devices().await.map_err(|value| {
        error(
            "device_discovery",
            format!("could not list devices: {value}"),
            true,
        )
    })?;
    serde_json::to_value(devices.into_iter().map(device_summary).collect::<Vec<_>>())
        .map_err(|value| error("serialization", value.to_string(), false))
}

async fn device_event_snapshot(state: &BridgeState) -> Result<Value, RpcError> {
    Ok(json!({
        "type": "device_snapshot",
        "sequence": next_event_sequence(state),
        "devices": list_devices(state).await?,
    }))
}

async fn stream_device_events(
    stream: &mut UnixStream,
    state: Arc<BridgeState>,
    request_id: String,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            _ = interval.tick() => {
                let result = device_event_snapshot(&state).await;
                let output = match result {
                    Ok(value) => response(request_id.clone(), value),
                    Err(value) => failure(request_id.clone(), value),
                };
                if write_frame(stream, &output).await.is_err() { return; }
            }
            frame = read_frame(stream) => {
                if frame.is_err() || frame.ok().flatten().is_none() { return; }
            }
        }
    }
}

async fn device_metadata(state: &BridgeState, id: &str) -> Result<Value, RpcError> {
    let (provider, _) = provider_for(state, id).await?;
    let mut lockdown = LockdownClient::connect(&provider).await.map_err(|value| {
        error(
            "lockdown_unavailable",
            format!("could not open lockdown: {value}"),
            true,
        )
    })?;
    let pairing = provider.get_pairing_file().await.map_err(|value| {
        error(
            "pairing_unavailable",
            format!("could not read pairing record: {value}"),
            true,
        )
    })?;
    lockdown.start_session(&pairing).await.map_err(|value| {
        error(
            "lockdown_session",
            format!("could not start lockdown session: {value}"),
            true,
        )
    })?;
    let mut values = Map::new();
    for key in [
        "DeviceName",
        "ProductType",
        "ProductVersion",
        "UniqueDeviceID",
        "SerialNumber",
        "BatteryCurrentCapacity",
        "BatteryIsCharging",
    ] {
        if let Some(value) = read_value(&mut lockdown, key).await {
            values.insert(key.to_string(), Value::String(value));
        }
    }
    Ok(Value::Object(values))
}

async fn pair_device(
    state: &BridgeState,
    id: &str,
    requested_host_id: Option<String>,
) -> Result<Value, RpcError> {
    let (device, addr) = find_device(state, id).await?;
    let mut mux = addr.connect(0).await.map_err(|value| {
        error(
            "mux_unavailable",
            format!("could not connect to netmuxd: {value}"),
            true,
        )
    })?;
    let system_buid = mux.get_buid().await.map_err(|value| {
        error(
            "pairing",
            format!("could not read system BUID: {value}"),
            true,
        )
    })?;
    let provider = device.to_provider(addr.clone(), format!("dkrypt-pair-{id}"));
    let mut lockdown = LockdownClient::connect(&provider).await.map_err(|value| {
        error(
            "lockdown_unavailable",
            format!("could not open lockdown: {value}"),
            true,
        )
    })?;
    let host_id = requested_host_id.unwrap_or_else(|| state.host_id.clone());
    let pairing = lockdown
        .pair_once(host_id.clone(), system_buid, Some("dkrypt"))
        .await
        .map_err(|value| {
            error(
                "pairing_pending",
                format!("device pairing requires trust confirmation: {value}"),
                true,
            )
        })?;
    let serialized = pairing.clone().serialize().map_err(|value| {
        error(
            "pairing",
            format!("could not serialize pairing record: {value}"),
            false,
        )
    })?;
    mux.save_pair_record(&device.udid, serialized)
        .await
        .map_err(|value| {
            error(
                "pairing",
                format!("could not save pairing record: {value}"),
                true,
            )
        })?;
    Ok(json!({ "deviceId": device.udid, "hostId": host_id, "paired": true }))
}

async fn write_agent_frame<T: tokio::io::AsyncWrite + Unpin>(
    socket: &mut T,
    payload: &Value,
) -> Result<(), RpcError> {
    let body = serde_json::to_vec(payload)
        .map_err(|value| error("serialization", value.to_string(), false))?;
    if !valid_frame_length(body.len(), 4 * 1024 * 1024) {
        return Err(error(
            "invalid_frame",
            "agent request exceeds frame limits",
            false,
        ));
    }
    socket
        .write_u32(body.len() as u32)
        .await
        .map_err(|value| error("agent_io", value.to_string(), true))?;
    socket
        .write_all(&body)
        .await
        .map_err(|value| error("agent_io", value.to_string(), true))?;
    socket
        .flush()
        .await
        .map_err(|value| error("agent_io", value.to_string(), true))
}

async fn read_agent_frame<T: tokio::io::AsyncRead + Unpin>(
    socket: &mut T,
) -> Result<Value, RpcError> {
    let length = socket
        .read_u32()
        .await
        .map_err(|value| error("agent_io", value.to_string(), true))? as usize;
    if !valid_frame_length(length, 4 * 1024 * 1024) {
        return Err(error(
            "invalid_frame",
            "agent response exceeds frame limits",
            false,
        ));
    }
    let mut response = vec![0; length];
    socket
        .read_exact(&mut response)
        .await
        .map_err(|value| error("agent_io", value.to_string(), true))?;
    serde_json::from_slice(&response)
        .map_err(|value| error("invalid_response", value.to_string(), false))
}

async fn request_agent(
    state: &BridgeState,
    id: &str,
    payload: Value,
    agent_secret: String,
    deadline_ms: u64,
) -> Result<Value, RpcError> {
    let (provider, _) = provider_for(state, id).await?;
    let device = provider
        .connect(DEFAULT_AGENT_PORT)
        .await
        .map_err(|value| {
            error(
                "agent_unavailable",
                format!("could not connect to autoinstall agent: {value}"),
                true,
            )
        })?;
    let mut socket = device.get_socket().ok_or_else(|| {
        error(
            "agent_unavailable",
            "agent connection did not expose a socket",
            true,
        )
    })?;
    let bootstrap = json!({ "version": 1, "requestId": Uuid::new_v4().to_string(), "action": "bootstrap", "secret": agent_secret });
    let deadline = Duration::from_millis(deadline_ms.clamp(1, 120_000));
    timeout(deadline, async {
        write_agent_frame(&mut socket, &bootstrap).await?;
        let bootstrap_response = read_agent_frame(&mut socket).await?;
        if bootstrap_response.get("ok") != Some(&Value::Bool(true)) {
            return Err(error(
                "agent_bootstrap",
                "device agent rejected the bridge secret",
                true,
            ));
        }
        write_agent_frame(&mut socket, &payload).await?;
        read_agent_frame(&mut socket).await
    })
    .await
    .map_err(|_| {
        error(
            "agent_timeout",
            "device agent did not respond before the deadline",
            true,
        )
    })?
}

async fn open_tunnel(
    state: Arc<BridgeState>,
    id: &str,
    remote_port: u16,
) -> Result<Value, RpcError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|value| error("tunnel_bind", value.to_string(), true))?;
    let local_port = listener
        .local_addr()
        .map_err(|value| error("tunnel_bind", value.to_string(), true))?
        .port();
    let tunnel_id = Uuid::new_v4().to_string();
    let device_id = id.to_string();
    let task_state = state.clone();
    let task = tokio::spawn(async move {
        loop {
            let accepted = listener.accept().await;
            let (mut incoming, _) = match accepted {
                Ok(value) => value,
                Err(_) => break,
            };
            let connection = provider_for(&task_state, &device_id).await;
            let (provider, _) = match connection {
                Ok(value) => value,
                Err(_) => continue,
            };
            let remote = provider.connect(remote_port).await;
            let mut device = match remote.and_then(|value| {
                value
                    .get_socket()
                    .ok_or_else(|| idevice::IdeviceError::NoEstablishedConnection)
            }) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let _ = copy_bidirectional(&mut incoming, &mut device).await;
        }
    });
    state.tunnels.lock().await.insert(tunnel_id.clone(), task);
    Ok(
        json!({ "tunnelId": tunnel_id, "host": "127.0.0.1", "port": local_port, "remotePort": remote_port }),
    )
}

async fn close_tunnel(state: &BridgeState, tunnel_id: &str) -> Value {
    if let Some(task) = state.tunnels.lock().await.remove(tunnel_id) {
        task.abort();
        json!({ "closed": true })
    } else {
        json!({ "closed": false })
    }
}

async fn execute(state: Arc<BridgeState>, request: RpcRequest) -> Result<Value, RpcError> {
    match request.operation.as_str() {
        "capabilities" => Ok(
            json!({ "protocolVersion": RPC_VERSION, "transport": "rust-netmuxd", "capabilities": bridge_capabilities() }),
        ),
        "cancel" => {
            let request_id = request
                .payload
                .as_ref()
                .and_then(Value::as_str)
                .ok_or_else(|| error("invalid_request", "request id is required", false))?;
            Ok(
                json!({ "cancelled": state.cancel_request(request_id).await, "requestId": request_id }),
            )
        }
        "health" => {
            let devices = list_devices(&state).await?;
            let transport = devices
                .as_array()
                .map(|values| {
                    let has_usb = values
                        .iter()
                        .any(|value| value.get("transport").and_then(Value::as_str) == Some("usb"));
                    let has_wifi = values.iter().any(|value| {
                        value
                            .get("transport")
                            .and_then(Value::as_str)
                            .is_some_and(|value| value.starts_with("wifi:"))
                    });
                    match (has_usb, has_wifi) {
                        (true, true) => "mixed",
                        (true, false) => "usb",
                        (false, true) => "wifi",
                        (false, false) => "unknown",
                    }
                })
                .unwrap_or("unknown");
            let device_present = request.device_id.as_deref().map_or_else(
                || devices.as_array().is_some_and(|values| !values.is_empty()),
                |device_id| {
                    devices.as_array().is_some_and(|values| {
                        values.iter().any(|value| {
                            value.get("udid").and_then(Value::as_str) == Some(device_id)
                                || value.get("id").and_then(Value::as_str) == Some(device_id)
                        })
                    })
                },
            );
            Ok(
                json!({ "state": "ready", "transport": transport, "deviceCount": devices.as_array().map_or(0, Vec::len), "devicePresent": device_present, "muxSocket": state.mux_socket, "capabilities": bridge_capabilities() }),
            )
        }
        "list_devices" => list_devices(&state).await,
        "events" => device_event_snapshot(&state).await,
        "metadata" => {
            device_metadata(
                &state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
            )
            .await
        }
        "pair" => {
            pair_device(
                &state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request.host_id,
            )
            .await
        }
        "agent" => {
            request_agent(
                &state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request
                    .payload
                    .ok_or_else(|| error("invalid_request", "payload is required", false))?,
                request
                    .agent_secret
                    .ok_or_else(|| error("invalid_request", "agent_secret is required", false))?,
                request.deadline_ms.unwrap_or(20_000),
            )
            .await
        }
        "remote_command" => {
            request_agent(
                &state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request
                    .payload
                    .ok_or_else(|| error("invalid_request", "payload is required", false))?,
                request
                    .agent_secret
                    .ok_or_else(|| error("invalid_request", "agent_secret is required", false))?,
                request.deadline_ms.unwrap_or(20_000),
            )
            .await
        }
        "file_read" | "file_write" => {
            request_agent(
                &state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request
                    .payload
                    .ok_or_else(|| error("invalid_request", "payload is required", false))?,
                request
                    .agent_secret
                    .ok_or_else(|| error("invalid_request", "agent_secret is required", false))?,
                request.deadline_ms.unwrap_or(20_000),
            )
            .await
        }
        "service_port" => {
            open_tunnel(
                state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request
                    .port
                    .ok_or_else(|| error("invalid_request", "port is required", false))?,
            )
            .await
        }
        "open_tunnel" => {
            open_tunnel(
                state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request.port.unwrap_or(DEFAULT_SSH_PORT),
            )
            .await
        }
        "close_tunnel" => Ok(close_tunnel(
            &state,
            request
                .payload
                .as_ref()
                .and_then(Value::as_str)
                .ok_or_else(|| error("invalid_request", "tunnel id is required", false))?,
        )
        .await),
        _ => Err(error(
            "unsupported_operation",
            format!("unsupported operation {}", request.operation),
            false,
        )),
    }
}

async fn read_frame(stream: &mut UnixStream) -> Result<Option<Vec<u8>>, String> {
    let mut header = [0; 4];
    match stream.read_exact(&mut header).await {
        Ok(_) => {}
        Err(value) if value.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(value) => return Err(value.to_string()),
    }
    let length = u32::from_be_bytes(header) as usize;
    if !valid_frame_length(length, MAX_FRAME_BYTES) {
        return Err("frame length is outside the allowed range".to_string());
    }
    let mut body = vec![0; length];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|value| value.to_string())?;
    Ok(Some(body))
}

async fn write_frame(stream: &mut UnixStream, response: &RpcResponse) -> Result<(), String> {
    let body = serde_json::to_vec(response).map_err(|value| value.to_string())?;
    if !valid_frame_length(body.len(), MAX_FRAME_BYTES) {
        return Err("response exceeds frame limits".to_string());
    }
    stream
        .write_u32(body.len() as u32)
        .await
        .map_err(|value| value.to_string())?;
    stream
        .write_all(&body)
        .await
        .map_err(|value| value.to_string())?;
    stream.flush().await.map_err(|value| value.to_string())
}

async fn handle_client(mut stream: UnixStream, state: Arc<BridgeState>) {
    loop {
        let frame = match read_frame(&mut stream).await {
            Ok(Some(frame)) => frame,
            Ok(None) | Err(_) => return,
        };
        let request = match serde_json::from_slice::<RpcRequest>(&frame) {
            Ok(request) => request,
            Err(value) => {
                let _ = write_frame(
                    &mut stream,
                    &failure(
                        String::new(),
                        error("invalid_request", value.to_string(), false),
                    ),
                )
                .await;
                continue;
            }
        };
        let request_id = request.request_id.clone();
        let operation = request.operation.clone();
        let follow_events = operation == "events" && request.follow == Some(true);
        let result = if request.version != RPC_VERSION {
            Err(error(
                "protocol_version",
                "unsupported RPC protocol version",
                false,
            ))
        } else if !authorized_secret(&state.secrets, &request.auth) {
            Err(error(
                "unauthorized",
                "device bridge authentication failed",
                false,
            ))
        } else if follow_events {
            stream_device_events(&mut stream, state.clone(), request_id).await;
            return;
        } else {
            let deadline =
                Duration::from_millis(request.deadline_ms.unwrap_or(20_000).clamp(1, 120_000));
            if operation == "cancel" {
                match timeout(deadline, execute(state.clone(), request)).await {
                    Ok(value) => value,
                    Err(_) => Err(error(
                        "deadline_exceeded",
                        "device bridge request exceeded its deadline",
                        true,
                    )),
                }
            } else {
                let cancellation = state.register_cancellation(&request_id).await;
                let result = tokio::select! {
                    value = execute(state.clone(), request) => value,
                    _ = cancellation.cancelled() => Err(error("cancelled", "device bridge request was cancelled", true)),
                    _ = sleep(deadline) => Err(error("deadline_exceeded", "device bridge request exceeded its deadline", true)),
                };
                state.remove_cancellation(&request_id).await;
                result
            }
        };
        let output = match result {
            Ok(result) => response(request_id, result),
            Err(value) => failure(request_id, value),
        };
        if write_frame(&mut stream, &output).await.is_err() {
            return;
        }
    }
}

async fn wait_for_path(path: &Path) -> Result<(), String> {
    for _ in 0..100 {
        if path.exists() {
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }
    Err(format!("netmuxd did not create {}", path.display()))
}

fn start_netmuxd(binary: &str, socket: &Path, pairing_store: &Path) -> Result<Child, String> {
    Command::new(binary)
        .arg("--socket-path")
        .arg(socket)
        .arg("--plist-storage")
        .arg(pairing_store)
        .env(
            "RUST_LOG",
            env::var("NETMUXD_LOG_LEVEL").unwrap_or_else(|_| "warn".to_string()),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|value| format!("could not start netmuxd: {value}"))
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let rpc_socket = unix_path("DEVICE_BRIDGE_SOCKET", "/run/dkrypt/device-bridge.sock");
    let mux_socket = unix_path("DEVICE_MUX_SOCKET", "/run/dkrypt/usbmuxd.sock");
    let pairing_store = unix_path("DEVICE_PAIRING_STORE", "/data/state/device-pairing");
    let secret = required_env("DEVICE_BRIDGE_SECRET").map_err(|value| value.message)?;
    if secret.len() < 32 {
        return Err("DEVICE_BRIDGE_SECRET must contain at least 32 characters".to_string());
    }
    let mut secrets = vec![secret];
    if let Ok(previous) = env::var("DEVICE_BRIDGE_SECRET_PREVIOUS") {
        if previous.len() >= 32 {
            secrets.push(previous);
        }
    }
    if let Some(parent) = rpc_socket.parent() {
        std::fs::create_dir_all(parent).map_err(|value| value.to_string())?;
    }
    if let Some(parent) = mux_socket.parent() {
        std::fs::create_dir_all(parent).map_err(|value| value.to_string())?;
    }
    std::fs::create_dir_all(&pairing_store).map_err(|value| value.to_string())?;
    std::fs::set_permissions(
        &pairing_store,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .map_err(|value| value.to_string())?;
    if rpc_socket.exists() {
        std::fs::remove_file(&rpc_socket).map_err(|value| value.to_string())?;
    }
    if mux_socket.exists() {
        std::fs::remove_file(&mux_socket).map_err(|value| value.to_string())?;
    }
    let binary = env::var("NETMUXD_BIN").unwrap_or_else(|_| "netmuxd".to_string());
    let mut netmuxd = start_netmuxd(&binary, &mux_socket, &pairing_store)?;
    wait_for_path(&mux_socket).await?;
    tokio::spawn(async move {
        let _ = netmuxd.wait().await;
        std::process::exit(1);
    });
    let host_id = env::var("DEVICE_BRIDGE_HOST_ID").unwrap_or_else(|_| Uuid::new_v4().to_string());
    let state = Arc::new(BridgeState {
        secrets,
        mux_socket,
        host_id,
        tunnels: Mutex::new(HashMap::new()),
        cancellations: Mutex::new(HashMap::new()),
        event_sequence: AtomicU64::new(0),
    });
    let listener = UnixListener::bind(&rpc_socket).map_err(|value| value.to_string())?;
    let permissions = std::os::unix::fs::PermissionsExt::from_mode(0o660);
    std::fs::set_permissions(&rpc_socket, permissions).map_err(|value| value.to_string())?;
    loop {
        let (stream, _) = listener.accept().await.map_err(|value| value.to_string())?;
        let client_state = state.clone();
        tokio::spawn(async move {
            handle_client(stream, client_state).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BridgeState, CancellationToken, MAX_FRAME_BYTES, RPC_VERSION, authorized_secret,
        bridge_capabilities, error, failure, handle_client, read_frame, response,
        valid_frame_length,
    };
    use serde_json::json;
    use std::{
        collections::HashMap,
        path::PathBuf,
        sync::{Arc, atomic::AtomicU64},
    };
    use tokio::{
        io::AsyncWriteExt,
        net::{UnixListener, UnixStream},
        sync::Mutex,
    };

    #[test]
    fn frame_limits_reject_empty_and_oversized_payloads() {
        assert!(!valid_frame_length(0, MAX_FRAME_BYTES));
        assert!(valid_frame_length(1, MAX_FRAME_BYTES));
        assert!(valid_frame_length(MAX_FRAME_BYTES, MAX_FRAME_BYTES));
        assert!(!valid_frame_length(MAX_FRAME_BYTES + 1, MAX_FRAME_BYTES));
    }

    #[test]
    fn responses_preserve_request_ids_and_protocol_version() {
        let success = response("request-1".to_string(), json!({ "ok": true }));
        assert_eq!(success.version, RPC_VERSION);
        assert_eq!(success.request_id, "request-1");
        assert!(success.ok);
        assert_eq!(
            serde_json::to_value(&success).unwrap()["requestId"],
            "request-1"
        );
        let failed = failure("request-2".to_string(), error("test", "failed", false));
        assert_eq!(failed.version, RPC_VERSION);
        assert_eq!(failed.request_id, "request-2");
        assert!(!failed.ok);
    }

    #[test]
    fn secret_rotation_accepts_current_and_previous_only() {
        let secrets = vec!["current-secret".to_string(), "previous-secret".to_string()];
        assert!(authorized_secret(&secrets, "current-secret"));
        assert!(authorized_secret(&secrets, "previous-secret"));
        assert!(!authorized_secret(&secrets, "unknown-secret"));
    }

    #[test]
    fn cancellation_is_advertised_as_a_bridge_capability() {
        assert!(bridge_capabilities().contains(&"cancel"));
    }

    #[tokio::test]
    async fn cancellation_wakes_waiting_requests() {
        let token = CancellationToken::new();
        let waiter = {
            let token = token.clone();
            tokio::spawn(async move {
                token.cancelled().await;
                true
            })
        };
        token.cancel();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
                .await
                .expect("cancellation waiter timed out")
                .expect("cancellation waiter panicked")
        );
    }

    #[tokio::test]
    async fn rpc_socket_preserves_authentication_and_request_ids() {
        let socket_path =
            std::env::temp_dir().join(format!("dkrypt-bridge-test-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("test socket bind failed");
        let state = Arc::new(BridgeState {
            secrets: vec!["current-secret".to_string()],
            mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            host_id: "test-host".to_string(),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
        });
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("test socket accept failed");
            handle_client(stream, state).await;
        });
        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("test socket connect failed");
        let request = json!({
            "version": RPC_VERSION,
            "requestId": "capability-request",
            "auth": "current-secret",
            "operation": "capabilities"
        });
        let body = serde_json::to_vec(&request).expect("test request serialization failed");
        client
            .write_u32(body.len() as u32)
            .await
            .expect("test request header failed");
        client
            .write_all(&body)
            .await
            .expect("test request body failed");
        let response: serde_json::Value = serde_json::from_slice(
            &read_frame(&mut client)
                .await
                .expect("test response frame failed")
                .expect("test response was empty"),
        )
        .expect("test response serialization failed");
        assert_eq!(
            response.get("requestId").and_then(|value| value.as_str()),
            Some("capability-request")
        );
        assert_eq!(
            response.get("ok").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            response
                .get("result")
                .and_then(|value| value.get("transport"))
                .and_then(|value| value.as_str()),
            Some("rust-netmuxd")
        );
        server.abort();
        let _ = std::fs::remove_file(socket_path);
    }
}
