//! WebSocket signaling client.
//!
//! Connects to `/v1/signaling`, sends `Identify` as the first frame,
//! awaits `Welcome`, then exposes a typed send/receive loop for
//! relayed payloads. Encoding is postcard binary frames, matching the
//! server.

use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crocodile_protocol::ids::{DeviceId, ServerId};
use crocodile_protocol::signaling::{SignalingClientFrame, SignalingServerFrame};

use crate::error::{ClientError, Result};

/// A connected, identified signaling channel.
///
/// Holds a background task that pumps the underlying WebSocket and
/// exposes channels for sending [`SignalingClientFrame::Relay`] and
/// receiving [`SignalingServerFrame`]s.
#[derive(Debug)]
pub struct SignalingChannel {
    server_id: ServerId,
    outbound: mpsc::UnboundedSender<SignalingClientFrame>,
    inbound: mpsc::UnboundedReceiver<SignalingServerFrame>,
    _task: tokio::task::JoinHandle<()>,
}

impl SignalingChannel {
    /// Connect, identify, and await the server's `Welcome` frame.
    ///
    /// `base_url` is the HTTP base of the coordination server
    /// (e.g. `http://example.com`); we rewrite the scheme to ws/wss
    /// for the upgrade.
    pub async fn connect(base_url: &str, session_token: &str, device_id: DeviceId) -> Result<Self> {
        let ws_url = http_to_ws_url(base_url);
        let url = format!("{ws_url}/v1/signaling");

        // tokio-tungstenite supports building a custom request so we
        // can attach the Authorization header on the upgrade.
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut req = url.into_client_request().map_err(ClientError::from)?;
        req.headers_mut().insert(
            "Authorization",
            format!("Bearer {session_token}")
                .parse()
                .expect("bearer header always parses"),
        );

        let (mut ws, _resp) = connect_async(req).await.map_err(ClientError::from)?;

        // Send Identify, then read until Welcome.
        send_frame(&mut ws, &SignalingClientFrame::Identify { device_id }).await?;
        let server_id = match recv_frame(&mut ws).await? {
            SignalingServerFrame::Welcome { server_id, .. } => server_id,
            other => {
                return Err(ClientError::Other(anyhow::anyhow!(
                    "expected Welcome, got {other:?}"
                )))
            }
        };

        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<SignalingClientFrame>();
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<SignalingServerFrame>();

        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    // Outbound: caller wants to send a frame.
                    maybe_frame = outbound_rx.recv() => match maybe_frame {
                        Some(frame) => {
                            if let Err(e) = send_frame(&mut ws, &frame).await {
                                tracing::debug!(error = ?e, "ws send failed; closing");
                                break;
                            }
                        }
                        None => break, // outbound tx dropped → caller gone
                    },

                    // Inbound: server sent us something.
                    maybe_msg = ws.next() => match maybe_msg {
                        Some(Ok(msg)) => match msg {
                            Message::Binary(bytes) => match postcard::from_bytes::<SignalingServerFrame>(&bytes) {
                                Ok(frame) => {
                                    if inbound_tx.send(frame).is_err() {
                                        break; // receiver gone
                                    }
                                }
                                Err(e) => tracing::debug!(error = %e, "decode server frame failed"),
                            },
                            Message::Close(_) => break,
                            _ => { /* ignore text / ping / pong */ }
                        },
                        Some(Err(e)) => {
                            tracing::debug!(error = ?e, "ws recv failed");
                            break;
                        }
                        None => break,
                    },
                }
            }
        });

        Ok(Self {
            server_id,
            outbound: outbound_tx,
            inbound: inbound_rx,
            _task: task,
        })
    }

    /// Server identity reported in the `Welcome` frame. Clients can
    /// cross-check this against the TOFU-pinned [`ServerId`].
    pub fn server_id(&self) -> ServerId {
        self.server_id
    }

    /// Enqueue a frame to send. Errors only if the underlying task
    /// has already exited (e.g. connection closed).
    pub fn send(&self, frame: SignalingClientFrame) -> Result<()> {
        self.outbound
            .send(frame)
            .map_err(|_| ClientError::Other(anyhow::anyhow!("signaling channel closed")))
    }

    /// Receive the next server frame. Returns `None` when the channel
    /// closes.
    pub async fn recv(&mut self) -> Option<SignalingServerFrame> {
        self.inbound.recv().await
    }
}

async fn send_frame(
    ws: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    frame: &SignalingClientFrame,
) -> Result<()> {
    let bytes = postcard::to_stdvec(frame)?;
    ws.send(Message::Binary(bytes)).await?;
    Ok(())
}

async fn recv_frame(
    ws: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
) -> Result<SignalingServerFrame> {
    loop {
        let msg = ws
            .next()
            .await
            .ok_or_else(|| ClientError::Other(anyhow::anyhow!("ws closed before frame")))??;
        match msg {
            Message::Binary(bytes) => {
                let frame: SignalingServerFrame = postcard::from_bytes(&bytes)?;
                return Ok(frame);
            }
            Message::Close(_) => {
                return Err(ClientError::Other(anyhow::anyhow!("ws closed")));
            }
            // Text/ping/pong: ignore and keep reading.
            _ => continue,
        }
    }
}

fn http_to_ws_url(base: &str) -> String {
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_rewrite() {
        assert_eq!(http_to_ws_url("http://x:1"), "ws://x:1");
        assert_eq!(http_to_ws_url("https://x"), "wss://x");
        assert_eq!(http_to_ws_url("foo://bar"), "foo://bar");
    }
}
