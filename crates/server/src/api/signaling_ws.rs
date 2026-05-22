//! WebSocket signaling endpoint.
//!
//! Wire protocol: postcard-encoded [`SignalingClientFrame`] /
//! [`SignalingServerFrame`] in binary WS frames. Text frames are
//! rejected.
//!
//! Lifecycle:
//!
//! 1. Client connects with `Authorization: Bearer <token>`.
//! 2. Server authenticates via [`AuthSession`].
//! 3. Server upgrades to WS, awaits first frame.
//! 4. First frame must be `SignalingClientFrame::Identify { device_id }`.
//!    Server confirms the device belongs to the authenticated account
//!    and registers the device → connection mapping.
//! 5. Server sends `SignalingServerFrame::Welcome`.
//! 6. Steady state: relay frames in both directions. Server forwards
//!    payloads unchanged; if the target is offline, replies with
//!    `UnreachableRecipient` on the sender's socket.
//!
//! All payloads are opaque to the server.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use tokio::sync::mpsc;

use crocodile_protocol::ids::DeviceId;
use crocodile_protocol::signaling::{SignalingClientFrame, SignalingServerFrame};
use crocodile_protocol::time::UnixSeconds;

use crate::api::auth_extract::AuthSession;
use crate::signaling::{Connection, Envelope};
use crate::AppState;

pub async fn signaling(
    State(state): State<AppState>,
    auth: AuthSession,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| run_socket(socket, state, auth))
}

async fn run_socket(mut socket: WebSocket, state: AppState, auth: AuthSession) {
    // Await the first frame — must be Identify.
    let device_id = match recv_identify(&mut socket).await {
        Ok(d) => d,
        Err(e) => {
            tracing::debug!(account = %auth.account_id, "identify failed: {e}");
            let _ = send_error(&mut socket, &format!("identify failed: {e}")).await;
            return;
        }
    };

    // Confirm the device belongs to the authenticated account.
    match device_belongs_to(state.storage.pool(), device_id, auth.account_id).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = send_error(&mut socket, "device does not belong to this account").await;
            return;
        }
        Err(e) => {
            tracing::error!(error = %e, "device ownership check failed");
            let _ = send_error(&mut socket, "internal error").await;
            return;
        }
    }

    // Set up the outbound channel and register with the hub.
    let (tx, mut rx) = mpsc::unbounded_channel::<Envelope>();
    state
        .signaling
        .register(device_id, Connection::new(tx))
        .await;
    tracing::debug!(?device_id, "device connected to signaling");

    // Welcome.
    let welcome = SignalingServerFrame::Welcome {
        server_id: state.identity.server_id(),
        server_time: UnixSeconds::now(),
    };
    let welcome_bytes = match postcard::to_stdvec(&welcome) {
        Ok(b) => b,
        Err(e) => {
            tracing::error!(error = %e, "encoding welcome failed");
            state.signaling.deregister(device_id).await;
            return;
        }
    };
    if socket.send(Message::Binary(welcome_bytes.into())).await.is_err() {
        state.signaling.deregister(device_id).await;
        return;
    }

    // Main loop: multiplex inbound WS frames and outbound hub deliveries.
    loop {
        tokio::select! {
            // Outbound: something to deliver from the hub.
            maybe_env = rx.recv() => match maybe_env {
                Some(env) => {
                    if socket.send(Message::Binary(env.bytes.into())).await.is_err() {
                        break;
                    }
                }
                None => break, // sender dropped — connection torn down.
            },

            // Inbound: a frame from the client.
            maybe_msg = socket.recv() => match maybe_msg {
                Some(Ok(Message::Binary(bytes))) => {
                    if let Err(e) = handle_client_frame(&state, device_id, &bytes).await {
                        tracing::debug!(?device_id, "frame error: {e}");
                        let _ = send_error_via_socket(&mut socket, &e.to_string()).await;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_other)) => {
                    // Text / ping / pong frames are not part of our
                    // protocol; ignore rather than error so heartbeats
                    // injected by intermediaries don't tear us down.
                }
                Some(Err(e)) => {
                    tracing::debug!(?device_id, "ws error: {e}");
                    break;
                }
            },
        }
    }

    state.signaling.deregister(device_id).await;
    tracing::debug!(?device_id, "device disconnected from signaling");
}

async fn recv_identify(socket: &mut WebSocket) -> Result<DeviceId, String> {
    let msg = socket
        .recv()
        .await
        .ok_or("connection closed before identify")?
        .map_err(|e| format!("recv error: {e}"))?;
    let bytes = match msg {
        Message::Binary(b) => b,
        _ => return Err("first frame must be binary".into()),
    };
    let frame: SignalingClientFrame = postcard::from_bytes(&bytes)
        .map_err(|e| format!("decode error: {e}"))?;
    match frame {
        SignalingClientFrame::Identify { device_id } => Ok(device_id),
        _ => Err("first frame must be Identify".into()),
    }
}

async fn device_belongs_to(
    pool: &sqlx::PgPool,
    device: DeviceId,
    account_id: uuid::Uuid,
) -> Result<bool, sqlx::Error> {
    let exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM devices WHERE device_id = $1 AND account_id = $2",
    )
    .bind(device.as_bytes().as_slice())
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(exists.is_some())
}

async fn handle_client_frame(
    state: &AppState,
    sender_device: DeviceId,
    bytes: &[u8],
) -> Result<(), String> {
    let frame: SignalingClientFrame =
        postcard::from_bytes(bytes).map_err(|e| format!("decode error: {e}"))?;
    match frame {
        SignalingClientFrame::Identify { .. } => Err("Identify only valid as first frame".into()),
        // `#[non_exhaustive]` on the protocol enum forces a wildcard
        // here; flag unknown variants as a protocol error so a future
        // additive change doesn't silently accept frames this server
        // doesn't yet handle.
        SignalingClientFrame::Relay { to, payload } => {
            let delivered = SignalingServerFrame::Delivered {
                from: sender_device,
                payload,
            };
            let env = Envelope {
                bytes: postcard::to_stdvec(&delivered)
                    .map_err(|e| format!("encode error: {e}"))?,
            };
            match state.signaling.deliver(to, env).await {
                crate::signaling::DeliveryOutcome::Delivered => Ok(()),
                crate::signaling::DeliveryOutcome::Unreachable => {
                    // Inform sender by sending back an Unreachable
                    // frame via their own hub slot — but to avoid an
                    // infinite recursion if the sender's connection is
                    // itself wonky, we deliver via the hub rather than
                    // touching the socket directly.
                    let frame = SignalingServerFrame::UnreachableRecipient { target: to };
                    let env = Envelope {
                        bytes: postcard::to_stdvec(&frame)
                            .map_err(|e| format!("encode error: {e}"))?,
                    };
                    let _ = state.signaling.deliver(sender_device, env).await;
                    Ok(())
                }
            }
        }
        _ => Err("unsupported signaling frame".into()),
    }
}

async fn send_error(socket: &mut WebSocket, message: &str) -> Result<(), axum::Error> {
    send_error_via_socket(socket, message).await
}

async fn send_error_via_socket(socket: &mut WebSocket, message: &str) -> Result<(), axum::Error> {
    let frame = SignalingServerFrame::Error {
        message: message.to_string(),
    };
    let bytes = postcard::to_stdvec(&frame).unwrap_or_default();
    socket.send(Message::Binary(bytes.into())).await
}
