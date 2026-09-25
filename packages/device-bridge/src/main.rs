use futures::StreamExt;
use idevice::{
    IdeviceService,
    provider::{IdeviceProvider, UsbmuxdProvider},
    services::lockdown::LockdownClient,
    usbmuxd::{UsbmuxdAddr, UsbmuxdConnection, UsbmuxdDevice, UsbmuxdListenEvent},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    env,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
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
    signal::unix::{SignalKind, signal},
    sync::{Mutex, Notify, mpsc, oneshot},
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

trait AgentStream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin {}

impl<T> AgentStream for T where T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin {}

type AgentConnectFuture =
    Pin<Box<dyn Future<Output = Result<Box<dyn AgentStream>, RpcError>> + Send>>;

trait AgentConnector: Send + Sync {
    fn connect(&self, device_id: String, port: u16) -> AgentConnectFuture;
}

struct UsbmuxdAgentConnector {
    mux_socket: PathBuf,
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
    agent_connector: Arc<dyn AgentConnector>,
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
    mux_socket: &Path,
    id: &str,
) -> Result<(UsbmuxdDevice, UsbmuxdAddr), RpcError> {
    let addr = UsbmuxdAddr::UnixSocket(mux_socket.to_string_lossy().to_string());
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
    mux_socket: &Path,
    id: &str,
) -> Result<(UsbmuxdProvider, UsbmuxdAddr), RpcError> {
    let (device, addr) = find_device(mux_socket, id).await?;
    Ok((
        device.to_provider(addr.clone(), format!("dkrypt-device-{id}")),
        addr,
    ))
}

impl AgentConnector for UsbmuxdAgentConnector {
    fn connect(&self, device_id: String, port: u16) -> AgentConnectFuture {
        let mux_socket = self.mux_socket.clone();
        Box::pin(async move {
            let (provider, _) = provider_for(&mux_socket, &device_id).await?;
            let device = provider.connect(port).await.map_err(|value| {
                error(
                    "agent_unavailable",
                    format!("could not connect to autoinstall agent: {value}"),
                    true,
                )
            })?;
            let socket = device.get_socket().ok_or_else(|| {
                error(
                    "agent_unavailable",
                    "agent connection did not expose a socket",
                    true,
                )
            })?;
            Ok(Box::new(socket) as Box<dyn AgentStream>)
        })
    }
}

async fn read_value(lockdown: &mut LockdownClient, key: &str) -> Option<String> {
    lockdown
        .get_value(Some(key), None)
        .await
        .ok()
        .and_then(|value| value.as_string().map(ToString::to_string))
}

async fn list_device_records(state: &BridgeState) -> Result<Vec<UsbmuxdDevice>, RpcError> {
    let mut mux = mux_connection(state).await?;
    mux.get_devices().await.map_err(|value| {
        error(
            "device_discovery",
            format!("could not list devices: {value}"),
            true,
        )
    })
}

async fn list_devices(state: &BridgeState) -> Result<Value, RpcError> {
    serde_json::to_value(
        list_device_records(state)
            .await?
            .into_iter()
            .map(device_summary)
            .collect::<Vec<_>>(),
    )
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
    let (events_tx, mut events_rx) = mpsc::channel(64);
    let (stop_tx, stop_rx) = oneshot::channel();
    let event_request_id = request_id.clone();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        match runtime {
            Ok(runtime) => runtime.block_on(stream_native_device_events(
                state,
                event_request_id,
                events_tx,
                stop_rx,
            )),
            Err(value) => {
                let _ = events_tx.blocking_send(failure(
                    event_request_id,
                    error(
                        "device_events",
                        format!("could not start device event listener: {value}"),
                        true,
                    ),
                ));
            }
        }
    });
    loop {
        tokio::select! {
            event = events_rx.recv() => match event {
                Some(value) => if write_frame(stream, &value).await.is_err() { return; },
                None => return,
            },
            frame = read_frame(stream) => {
                if frame.is_err() || frame.ok().flatten().is_none() {
                    let _ = stop_tx.send(());
                    return;
                }
            }
        }
    }
}

async fn stream_native_device_events(
    state: Arc<BridgeState>,
    request_id: String,
    sender: mpsc::Sender<RpcResponse>,
    stop: oneshot::Receiver<()>,
) {
    tokio::pin!(stop);
    let mut mux = tokio::select! {
        _ = &mut stop => return,
        result = mux_connection(&state) => match result {
            Ok(value) => value,
            Err(value) => {
                let _ = sender.send(failure(request_id, value)).await;
                return;
            }
        },
    };
    let mut events = tokio::select! {
        _ = &mut stop => return,
        result = mux.listen() => match result {
            Ok(value) => value,
            Err(value) => {
                let _ = sender
                    .send(failure(
                        request_id,
                        error(
                            "device_events",
                            format!("could not listen for usbmuxd events: {value}"),
                            true,
                        ),
                    ))
                    .await;
                return;
            }
        },
    };
    let initial = tokio::select! {
        _ = &mut stop => return,
        result = list_device_records(&state) => match result {
            Ok(value) => value,
            Err(value) => {
                let _ = sender.send(failure(request_id, value)).await;
                return;
            }
        },
    };
    let mut devices = initial
        .into_iter()
        .map(|device| (device.device_id, device))
        .collect::<BTreeMap<_, _>>();
    let snapshot = json!({
        "type": "device_snapshot",
        "sequence": next_event_sequence(&state),
        "devices": devices.values().cloned().map(device_summary).collect::<Vec<_>>(),
    });
    if sender
        .send(response(request_id.clone(), snapshot))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            _ = &mut stop => return,
            event = events.next() => {
                let (event_type, event_device_id) = match event {
                    Some(Ok(UsbmuxdListenEvent::Connected(device))) => {
                        let device_id = device.device_id;
                        devices.insert(device_id, device);
                        ("device_connected", device_id)
                    }
                    Some(Ok(UsbmuxdListenEvent::Disconnected(device_id))) => {
                        devices.remove(&device_id);
                        ("device_disconnected", device_id)
                    }
                    Some(Err(value)) => {
                        let output = failure(request_id.clone(), error("device_events", format!("usbmuxd event stream failed: {value}"), true));
                        let _ = sender.send(output).await;
                        return;
                    }
                    None => return,
                };
                let output = response(request_id.clone(), json!({
                    "type": event_type,
                    "sequence": next_event_sequence(&state),
                    "deviceId": event_device_id,
                    "devices": devices.values().cloned().map(device_summary).collect::<Vec<_>>(),
                }));
                if sender.send(output).await.is_err() { return; }
            }
        }
    }
}

async fn device_metadata(state: &BridgeState, id: &str) -> Result<Value, RpcError> {
    let (provider, _) = provider_for(&state.mux_socket, id).await?;
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
    let (device, addr) = find_device(&state.mux_socket, id).await?;
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

async fn request_agent_exchange<T>(
    socket: &mut T,
    agent_secret: &str,
    payload: &Value,
    deadline_ms: u64,
) -> Result<Value, RpcError>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let bootstrap = json!({
        "version": 1,
        "requestId": Uuid::new_v4().to_string(),
        "action": "bootstrap",
        "secret": agent_secret
    });
    let deadline = Duration::from_millis(deadline_ms.clamp(1, 120_000));
    timeout(deadline, async {
        write_agent_frame(socket, &bootstrap).await?;
        let bootstrap_response = read_agent_frame(socket).await?;
        if bootstrap_response.get("ok") != Some(&Value::Bool(true)) {
            return Err(error(
                "agent_bootstrap",
                "device agent rejected the bridge secret",
                true,
            ));
        }
        write_agent_frame(socket, payload).await?;
        read_agent_frame(socket).await
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

async fn request_agent(
    state: &BridgeState,
    id: &str,
    payload: Value,
    agent_secret: String,
    deadline_ms: u64,
) -> Result<Value, RpcError> {
    let mut socket = state
        .agent_connector
        .connect(id.to_string(), DEFAULT_AGENT_PORT)
        .await?;
    request_agent_exchange(&mut socket, &agent_secret, &payload, deadline_ms).await
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
            let connection = provider_for(&task_state.mux_socket, &device_id).await;
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

async fn stop_netmuxd(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
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
    if let Err(error) = wait_for_path(&mux_socket).await {
        stop_netmuxd(&mut netmuxd).await;
        return Err(error);
    }
    let host_id = env::var("DEVICE_BRIDGE_HOST_ID").unwrap_or_else(|_| Uuid::new_v4().to_string());
    let state = Arc::new(BridgeState {
        secrets,
        agent_connector: Arc::new(UsbmuxdAgentConnector {
            mux_socket: mux_socket.clone(),
        }),
        mux_socket,
        host_id,
        tunnels: Mutex::new(HashMap::new()),
        cancellations: Mutex::new(HashMap::new()),
        event_sequence: AtomicU64::new(0),
    });
    let listener = UnixListener::bind(&rpc_socket).map_err(|value| value.to_string())?;
    let permissions = std::os::unix::fs::PermissionsExt::from_mode(0o660);
    std::fs::set_permissions(&rpc_socket, permissions).map_err(|value| value.to_string())?;
    let mut terminate = signal(SignalKind::terminate()).map_err(|value| value.to_string())?;
    let mut interrupt = signal(SignalKind::interrupt()).map_err(|value| value.to_string())?;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.map_err(|value| value.to_string())?;
                let client_state = state.clone();
                tokio::spawn(async move {
                    handle_client(stream, client_state).await;
                });
            }
            _ = terminate.recv() => {
                stop_netmuxd(&mut netmuxd).await;
                let _ = std::fs::remove_file(&rpc_socket);
                let _ = std::fs::remove_file(&state.mux_socket);
                return Ok(());
            }
            _ = interrupt.recv() => {
                stop_netmuxd(&mut netmuxd).await;
                let _ = std::fs::remove_file(&rpc_socket);
                let _ = std::fs::remove_file(&state.mux_socket);
                return Ok(());
            }
            exited = netmuxd.wait() => {
                let status = exited.map_err(|value| value.to_string())?;
                let _ = std::fs::remove_file(&rpc_socket);
                let _ = std::fs::remove_file(&state.mux_socket);
                return Err(format!("netmuxd exited with {status}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AgentConnectFuture, AgentConnector, AgentStream, BridgeState, CancellationToken,
        MAX_FRAME_BYTES, RPC_VERSION, UsbmuxdAgentConnector, authorized_secret,
        bridge_capabilities, error, failure, handle_client, read_agent_frame, read_frame,
        request_agent_exchange, response, valid_frame_length, write_agent_frame,
    };
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use hmac::{Hmac, Mac};
    use serde_json::{Value, json};
    use sha2::Sha256;
    use std::{
        collections::HashMap,
        path::PathBuf,
        sync::{Arc, atomic::AtomicU64},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tokio::{
        io::{AsyncWriteExt, DuplexStream},
        net::{UnixListener, UnixStream},
        process::Command,
        sync::Mutex,
        time::timeout,
    };

    #[derive(Clone)]
    struct FixtureAgentConnector {
        stream: Arc<Mutex<Option<DuplexStream>>>,
        connect_calls: Arc<Mutex<Vec<(String, u16)>>>,
    }

    impl FixtureAgentConnector {
        fn new(stream: DuplexStream) -> Self {
            Self {
                stream: Arc::new(Mutex::new(Some(stream))),
                connect_calls: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl AgentConnector for FixtureAgentConnector {
        fn connect(&self, device_id: String, port: u16) -> AgentConnectFuture {
            let stream = Arc::clone(&self.stream);
            let connect_calls = Arc::clone(&self.connect_calls);
            Box::pin(async move {
                connect_calls.lock().await.push((device_id, port));
                let stream = stream.lock().await.take().ok_or_else(|| {
                    error("agent_unavailable", "fixture stream already used", true)
                })?;
                Ok(Box::new(stream) as Box<dyn AgentStream>)
            })
        }
    }

    fn hmac_signature(secret: &str, message: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .expect("HMAC accepts any secret length");
        mac.update(message.as_bytes());
        let digest = mac.finalize().into_bytes();
        let mut signature = String::with_capacity(digest.len() * 2);
        for byte in digest {
            signature.push(char::from(b"0123456789abcdef"[(byte >> 4) as usize]));
            signature.push(char::from(b"0123456789abcdef"[(byte & 0x0f) as usize]));
        }
        signature
    }

    fn current_agent_response(fixture: &Value, secret: &str, request_id: &str) -> Value {
        let issued_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_secs();
        let payload = fixture["responsePayload"]
            .as_str()
            .expect("fixture response payload should be a string");
        let message =
            format!("dkrypt-autoinstall-agent-response-v1|{request_id}|{issued_at}|{payload}");
        let signature = hmac_signature(secret, &message);
        json!({
            "version": 1,
            "requestId": request_id,
            "issuedAt": issued_at,
            "payload": payload,
            "signature": signature
        })
    }

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
    async fn device_agent_fixture_bootstraps_then_accepts_the_signed_request() {
        let (mut bridge, mut agent) = tokio::io::duplex(16 * 1024);
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/device-agent-v1.fixture.json"))
                .expect("device-agent fixture should be valid JSON");
        let request = fixture["envelope"].clone();
        let agent_secret = fixture["secret"]
            .as_str()
            .expect("device-agent fixture should contain a secret")
            .to_string();
        let response_payload = json!({ "ok": true, "result": { "agentVersion": "1.4.0" } });
        let expected_request = request.clone();
        let expected_response = response_payload.clone();
        let expected_secret = agent_secret.clone();
        let fixture = tokio::spawn(async move {
            let bootstrap = read_agent_frame(&mut agent)
                .await
                .expect("bootstrap frame should be readable");
            assert_eq!(
                bootstrap.get("action").and_then(Value::as_str),
                Some("bootstrap")
            );
            assert_eq!(
                bootstrap.get("secret").and_then(Value::as_str),
                Some(expected_secret.as_str())
            );
            write_agent_frame(&mut agent, &json!({ "ok": true }))
                .await
                .expect("bootstrap response should be writable");
            let forwarded = read_agent_frame(&mut agent)
                .await
                .expect("authenticated request frame should be readable");
            assert_eq!(forwarded, expected_request);
            write_agent_frame(&mut agent, &expected_response)
                .await
                .expect("agent response should be writable");
        });

        let response = request_agent_exchange(&mut bridge, &agent_secret, &request, 1_000)
            .await
            .expect("device-agent exchange should succeed");
        fixture.await.expect("device-agent fixture should complete");
        assert_eq!(response, response_payload);
    }

    #[tokio::test]
    async fn device_agent_fixture_rejects_a_failed_bootstrap() {
        let (mut bridge, mut agent) = tokio::io::duplex(16 * 1024);
        let fixture = tokio::spawn(async move {
            let _bootstrap = read_agent_frame(&mut agent)
                .await
                .expect("bootstrap frame should be readable");
            write_agent_frame(
                &mut agent,
                &json!({ "ok": false, "error": "invalid_secret" }),
            )
            .await
            .expect("bootstrap rejection should be writable");
        });

        let error = request_agent_exchange(&mut bridge, "wrong-secret", &json!({}), 1_000)
            .await
            .expect_err("a rejected bootstrap must fail the exchange");
        fixture.await.expect("device-agent fixture should complete");
        assert_eq!(error.code, "agent_bootstrap");
    }

    #[tokio::test]
    async fn device_agent_fixture_times_out_when_the_bridge_stops_responding() {
        let (mut bridge, _agent) = tokio::io::duplex(16 * 1024);
        let error = request_agent_exchange(&mut bridge, "fixture-secret", &json!({}), 50)
            .await
            .expect_err("an unresponsive agent must time out");
        assert_eq!(error.code, "agent_timeout");
    }

    #[tokio::test]
    async fn authenticated_agent_rpc_returns_the_device_agent_response() {
        let socket_path = PathBuf::from(format!("/tmp/dkrypt-agent-{}.sock", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&socket_path).expect("test socket bind failed");
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/device-agent-v1.fixture.json"))
                .expect("device-agent fixture should be valid JSON");
        let (bridge_agent, mut device_agent) = tokio::io::duplex(16 * 1024);
        let connector = FixtureAgentConnector::new(bridge_agent);
        let expected_request = fixture["envelope"].clone();
        let expected_secret = fixture["secret"]
            .as_str()
            .expect("device-agent fixture should contain a secret")
            .to_string();
        let request_id = fixture["requestId"]
            .as_str()
            .expect("fixture request ID should be a string");
        let expected_response = current_agent_response(&fixture, &expected_secret, request_id);
        let response_to_device = expected_response.clone();
        let device_agent_task = tokio::spawn(async move {
            let bootstrap = read_agent_frame(&mut device_agent)
                .await
                .expect("bootstrap frame should be readable");
            assert_eq!(bootstrap["action"], "bootstrap");
            assert_eq!(bootstrap["secret"], expected_secret);
            write_agent_frame(&mut device_agent, &json!({ "ok": true }))
                .await
                .expect("bootstrap response should be writable");
            let request = read_agent_frame(&mut device_agent)
                .await
                .expect("signed request should be readable");
            assert_eq!(request, expected_request);
            write_agent_frame(&mut device_agent, &response_to_device)
                .await
                .expect("signed response should be writable");
        });
        let state = Arc::new(BridgeState {
            secrets: vec!["bridge-test-secret".to_string()],
            mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            host_id: "test-host".to_string(),
            agent_connector: Arc::new(connector.clone()),
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
        let request_id = "agent-rpc-fixture-request";
        let request = json!({
            "version": RPC_VERSION,
            "requestId": request_id,
            "auth": "bridge-test-secret",
            "operation": "agent",
            "deviceId": "fixture-device",
            "payload": fixture["envelope"],
            "agentSecret": fixture["secret"],
            "deadlineMs": 1_000
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
        let output = read_frame(&mut client)
            .await
            .expect("test response frame failed")
            .expect("test response was empty");
        let output: Value =
            serde_json::from_slice(&output).expect("test response should be valid JSON");

        assert_eq!(output["requestId"], request_id);
        assert_eq!(output["ok"], true);
        assert_eq!(output["result"], expected_response);
        assert_eq!(
            connector.connect_calls.lock().await.as_slice(),
            &[("fixture-device".to_string(), 5913)]
        );
        device_agent_task
            .await
            .expect("mock device agent should complete");
        server.abort();
        let _ = std::fs::remove_file(socket_path);
    }

    #[tokio::test]
    async fn bun_device_agent_client_roundtrips_through_authenticated_rust_rpc() {
        let socket_path =
            PathBuf::from(format!("/tmp/dkrypt-bun-rpc-{}.sock", uuid::Uuid::new_v4()));
        let runtime_dir =
            std::env::temp_dir().join(format!("dkrypt-bun-rpc-runtime-{}", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&socket_path).expect("test socket bind failed");
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/device-agent-v1.fixture.json"))
                .expect("device-agent fixture should be valid JSON");
        let bridge_secret = fixture["secret"]
            .as_str()
            .expect("device-agent fixture should contain a secret")
            .to_string();
        let (bridge_agent, mut device_agent) = tokio::io::duplex(16 * 1024);
        let connector = FixtureAgentConnector::new(bridge_agent);
        let state = Arc::new(BridgeState {
            secrets: vec![bridge_secret.clone()],
            mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            host_id: "test-host".to_string(),
            agent_connector: Arc::new(connector.clone()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
        });
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.expect("test socket accept failed");
                let client_state = state.clone();
                tokio::spawn(async move {
                    handle_client(stream, client_state).await;
                });
            }
        });
        let fixture_for_agent = fixture.clone();
        let device_agent_task = tokio::spawn(async move {
            let bootstrap = read_agent_frame(&mut device_agent)
                .await
                .expect("bootstrap frame should be readable");
            assert_eq!(bootstrap["action"], "bootstrap");
            let agent_secret = bootstrap["secret"]
                .as_str()
                .expect("bootstrap should contain the device-agent secret");
            assert_eq!(agent_secret.len(), 43);
            write_agent_frame(&mut device_agent, &json!({ "ok": true }))
                .await
                .expect("bootstrap response should be writable");
            let request = read_agent_frame(&mut device_agent)
                .await
                .expect("signed request should be readable");
            assert_eq!(request["version"], 1);
            let request_id = request["requestId"]
                .as_str()
                .expect("signed request should contain a request ID");
            let request_issued_at = request["issuedAt"]
                .as_u64()
                .expect("signed request should contain an issue time");
            let request_payload = request["payload"]
                .as_str()
                .expect("signed request should contain a payload");
            let request_signature = request["signature"]
                .as_str()
                .expect("signed request should contain a signature");
            let signing_message = format!(
                "dkrypt-autoinstall-agent-v1|{request_id}|{request_issued_at}|{request_payload}"
            );
            assert_eq!(
                request_signature,
                hmac_signature(agent_secret, &signing_message)
            );
            let request_payload = URL_SAFE_NO_PAD
                .decode(request_payload)
                .expect("signed request payload should be base64url");
            let request_payload: Value = serde_json::from_slice(&request_payload)
                .expect("signed request payload should be valid JSON");
            assert_eq!(request_payload["action"], "status");
            let response = current_agent_response(&fixture_for_agent, agent_secret, request_id);
            write_agent_frame(&mut device_agent, &response)
                .await
                .expect("signed response should be writable");
        });
        let client_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../dkrypt/scripts/device-agent-client.integration.mjs");
        let output = timeout(
            Duration::from_secs(20),
            Command::new("bun")
                .args(["run"])
                .arg(client_script)
                .env("API_KEY", "rpc-integration-test")
                .env("SESSION_SIGNING_SECRET", "rpc-integration-test")
                .env("ADMIN_PASSWORD", "rpc-integration-test")
                .env("DEVICE_BRIDGE_SOCKET", &socket_path)
                .env("DEVICE_BRIDGE_SECRET", &bridge_secret)
                .env("DEVICE_RUNTIME_DIR", &runtime_dir)
                .kill_on_drop(true)
                .output(),
        )
        .await;
        let output = match output {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                server.abort();
                device_agent_task.abort();
                let _ = std::fs::remove_file(&socket_path);
                let _ = std::fs::remove_dir_all(&runtime_dir);
                panic!(
                    "Bun should be installed to run the Rust/Bun device-agent integration test: {error}"
                );
            }
            Err(_) => {
                server.abort();
                device_agent_task.abort();
                let _ = std::fs::remove_file(&socket_path);
                let _ = std::fs::remove_dir_all(&runtime_dir);
                panic!("Bun device-agent integration timed out");
            }
        };
        if !output.status.success() {
            server.abort();
            device_agent_task.abort();
            let _ = std::fs::remove_file(&socket_path);
            let _ = std::fs::remove_dir_all(&runtime_dir);
            panic!(
                "Bun device-agent client failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let agent_result = device_agent_task.await;
        let server_result = server.await;
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&runtime_dir);
        assert!(String::from_utf8_lossy(&output.stdout).contains("DKRYPT_RPC_OK"));
        agent_result.expect("mock device agent should complete");
        server_result.expect("RPC server should accept both Bun requests");
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
            agent_connector: Arc::new(UsbmuxdAgentConnector {
                mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            }),
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
