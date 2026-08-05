//! Top-level egui app: holds settings, the current screen, and a
//! background tokio runtime that runs the actual call session.

use std::path::PathBuf;
use std::sync::Arc;

use eframe::egui;
use tokio::runtime::Runtime;

use crate::session::{self, ProbeEvent, RoomInfo, SessionAction, SessionEvent, SessionHandle};

/// Persisted settings, loaded from / saved to `~/.config/crocodile/settings.json`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Settings {
    /// Coordination server URL, e.g. `http://1.2.3.4:8080`.
    pub server: String,
    /// Username (will be created on first call if it doesn't exist).
    pub username: String,
    /// Password (stored in plain text in settings.json — accepted
    /// tradeoff for the demo; the real product would use the OS
    /// keychain).
    pub password: String,
    /// Where to keep identity keys, MLS state seeds, text history.
    pub state_dir: String,
    /// QUIC bind addr (defaults to 0.0.0.0:0).
    pub bind_addr: String,
    /// Optional reachable address to advertise (auto-detected if empty).
    pub advertise_addr: String,
    /// Input (microphone) device name; `None` uses the system default.
    #[serde(default)]
    pub input_device: Option<String>,
    /// Output (speaker) device name; `None` uses the system default.
    #[serde(default)]
    pub output_device: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server: "http://127.0.0.1:8080".to_string(),
            username: String::new(),
            password: String::new(),
            // Absolute path under the home dir so the identity is stable
            // regardless of which directory the binary is launched from.
            // (A relative "./crocodile-state" would yield a *different*
            // identity per working directory, which desyncs from the
            // account registered on the server.)
            state_dir: default_state_dir(),
            bind_addr: "0.0.0.0:0".to_string(),
            advertise_addr: String::new(),
            input_device: None,
            output_device: None,
        }
    }
}

fn default_state_dir() -> String {
    let mut p = dirs_home();
    p.push(".local");
    p.push("share");
    p.push("crocodile");
    p.push("state");
    p.to_string_lossy().into_owned()
}

impl Settings {
    fn config_path() -> PathBuf {
        let mut p = dirs_home();
        p.push(".config");
        p.push("crocodile");
        std::fs::create_dir_all(&p).ok();
        p.push("settings.json");
        p
    }

    fn load() -> Self {
        std::fs::read_to_string(Self::config_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self) {
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(Self::config_path(), s);
        }
    }
}

/// Dropdown for choosing an audio device, with "System default" as the
/// `None` option.
fn device_picker(ui: &mut egui::Ui, id: &str, devices: &[String], selected: &mut Option<String>) {
    let label = selected.clone().unwrap_or_else(|| "System default".into());
    egui::ComboBox::from_id_salt(id)
        .selected_text(label)
        .width(260.0)
        .show_ui(ui, |ui| {
            ui.selectable_value(selected, None, "System default");
            for d in devices {
                ui.selectable_value(selected, Some(d.clone()), d);
            }
        });
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Which top-level pane is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pane {
    Settings,
    Call,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CallStatus {
    Idle,
    Connecting,
    Active,
    Failed(String),
}

/// One displayed chat / status line.
#[derive(Debug, Clone)]
struct LogLine {
    sender: String,
    body: String,
}

/// Connection state from the last Connect/Refresh probe.
#[derive(Debug, Clone)]
struct Connected {
    username: String,
    server_id_hex: String,
    rooms: Vec<RoomInfo>,
}

pub struct CrocodileApp {
    runtime: Arc<Runtime>,
    settings: Settings,
    pane: Pane,
    my_user_id_hex: Option<String>,
    invite_username: String,
    room_id_hex: String,
    call: Option<SessionHandle>,
    status: CallStatus,
    log: Vec<LogLine>,
    chat_input: String,
    /// Result of the last successful Connect/Refresh probe.
    connected: Option<Connected>,
    /// In-flight probe, if any.
    probe: Option<tokio::sync::mpsc::UnboundedReceiver<ProbeEvent>>,
    /// True while a probe is running (for button state / spinner text).
    probing: bool,
    /// Last connect error, shown prominently on the Settings tab (the
    /// Call-tab log isn't visible while you're on Settings).
    connect_error: Option<String>,
    /// Cached audio device names.
    ///
    /// Enumerating CoreAudio devices measured ~177 ms — far beyond a
    /// frame budget. Doing it inline in the draw code pinned the UI at
    /// a few fps. Cache it and refresh only on demand.
    audio_devices: AudioDeviceList,
    /// Standalone mic test, so users can verify capture without being
    /// in a call.
    mic_test: Option<MicTest>,
}

/// Cached input/output device names.
#[derive(Debug, Default, Clone)]
struct AudioDeviceList {
    inputs: Vec<String>,
    outputs: Vec<String>,
    loaded: bool,
}

impl AudioDeviceList {
    fn refresh(&mut self) {
        self.inputs = crocodile_client::audio::capture::list_devices();
        self.outputs = crocodile_client::audio::playback::list_devices();
        self.loaded = true;
    }
}

/// A short-lived capture stream used only to prove the microphone
/// works. Held on its own thread because cpal streams are not `Send`.
struct MicTest {
    controls: Arc<crocodile_client::audio::AudioControls>,
    _stop: std::sync::mpsc::Sender<()>,
    error: Option<String>,
}

impl CrocodileApp {
    pub fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        let runtime = Arc::new(Runtime::new().expect("tokio runtime"));
        Self {
            runtime,
            settings: Settings::load(),
            pane: Pane::Settings,
            my_user_id_hex: None,
            invite_username: String::new(),
            room_id_hex: String::new(),
            call: None,
            status: CallStatus::Idle,
            log: Vec::new(),
            chat_input: String::new(),
            connected: None,
            probe: None,
            probing: false,
            connect_error: None,
            audio_devices: AudioDeviceList::default(),
            mic_test: None,
        }
    }

    /// Start a standalone microphone test: opens capture on the chosen
    /// input device and feeds the level meter until stopped. Lets a user
    /// confirm the mic works before joining a call, which is where this
    /// was previously only observable.
    fn start_mic_test(&mut self) {
        let controls = crocodile_client::audio::AudioControls::new();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let controls_for_thread = controls.clone();
        let device = self.settings.input_device.clone();
        let (err_tx, err_rx) = std::sync::mpsc::channel::<String>();

        std::thread::Builder::new()
            .name("crocodile-mic-test".into())
            .spawn(move || {
                // Samples are discarded; only the level meter matters.
                let (sink, mut drain) = tokio::sync::mpsc::unbounded_channel::<Vec<f32>>();
                std::thread::spawn(move || while drain.blocking_recv().is_some() {});
                let _stream = match crocodile_client::audio::capture::open_by_name(
                    device.as_deref(),
                    sink,
                    controls_for_thread,
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = err_tx.send(e.to_string());
                        return;
                    }
                };
                let _ = stop_rx.recv();
            })
            .expect("spawn mic test thread");

        // Give the stream a moment to fail fast on a bad device.
        std::thread::sleep(std::time::Duration::from_millis(150));
        let error = err_rx.try_recv().ok();
        if let Some(e) = &error {
            self.append_log("error", format!("mic test: {e}"));
        }
        self.mic_test = Some(MicTest {
            controls,
            _stop: stop_tx,
            error,
        });
    }

    fn start_connect(&mut self) {
        if self.settings.username.trim().is_empty() || self.settings.password.is_empty() {
            self.append_log("error", "fill username + password in Settings first");
            return;
        }
        self.settings.save();
        self.append_log(
            "status",
            format!("connecting to {} ...", self.settings.server),
        );
        self.probing = true;
        self.connected = None;
        self.connect_error = None;
        self.probe = Some(session::spawn_probe(&self.runtime, self.settings.clone()));
    }

    /// Delete (if owner) or leave (if member) a room, then refresh the
    /// list. Reuses the probe channel since the response is the same
    /// refreshed room list.
    fn forget_room(&mut self, room_id_hex: String) {
        self.append_log("status", "removing room…");
        self.probing = true;
        self.probe = Some(session::spawn_forget_room(
            &self.runtime,
            self.settings.clone(),
            room_id_hex,
        ));
    }

    fn drain_probe(&mut self) {
        let Some(rx) = self.probe.as_mut() else {
            return;
        };
        if let Ok(ev) = rx.try_recv() {
            self.probing = false;
            self.probe = None;
            match ev {
                ProbeEvent::Ok {
                    username,
                    server_id_hex,
                    rooms,
                } => {
                    let n = rooms.len();
                    self.append_log(
                        "status",
                        format!("connected as {username} — {n} room(s) available"),
                    );
                    self.connected = Some(Connected {
                        username,
                        server_id_hex,
                        rooms,
                    });
                    // Jump to the Call tab so the room list is visible.
                    self.pane = Pane::Call;
                }
                ProbeEvent::Err(e) => {
                    self.append_log("error", format!("connection failed: {e}"));
                    self.connect_error = Some(e);
                    self.connected = None;
                }
            }
        }
    }

    fn append_log(&mut self, sender: impl Into<String>, body: impl Into<String>) {
        let line = LogLine {
            sender: sender.into(),
            body: body.into(),
        };
        if self.log.len() > 500 {
            self.log.drain(..self.log.len() - 500);
        }
        self.log.push(line);
    }

    fn drain_session_events(&mut self) {
        // Drain into a local vector first so the borrow on
        // `self.call` is released before we call other &mut self
        // methods.
        let events: Vec<SessionEvent> = {
            let Some(handle) = self.call.as_mut() else {
                return;
            };
            let mut events = Vec::new();
            while let Ok(event) = handle.events.try_recv() {
                events.push(event);
            }
            events
        };
        for event in events {
            match event {
                SessionEvent::Status(s) => {
                    if s == "connected" {
                        self.status = CallStatus::Active;
                    }
                    self.append_log("status", &s);
                }
                SessionEvent::Text { from, body } => self.append_log(from, body),
                SessionEvent::Failed(e) => {
                    self.status = CallStatus::Failed(e.clone());
                    self.append_log("error", &e);
                }
                SessionEvent::Ended => {
                    self.append_log("status", "call ended");
                    self.status = CallStatus::Idle;
                    self.call = None;
                    return;
                }
            }
        }
    }

    fn start_print_id(&mut self) {
        // Quick helper: just learn / show our own user_id without
        // touching the network. Uses the same key persistence as the
        // CLI demo binaries.
        let dir = PathBuf::from(&self.settings.state_dir);
        match session::derive_my_ids(&dir) {
            Ok((user_id_hex, _device_id_hex)) => {
                self.my_user_id_hex = Some(user_id_hex);
            }
            Err(e) => {
                self.append_log("error", format!("identity load failed: {e}"));
            }
        }
    }

    fn start_host(&mut self) {
        let settings = self.settings.clone();
        let invite = self.invite_username.trim().to_string();
        if invite.is_empty() {
            self.append_log(
                "error",
                "enter an invitee username before starting a host call",
            );
            return;
        }
        if settings.username.is_empty() || settings.password.is_empty() {
            self.append_log("error", "fill username + password in settings first");
            return;
        }
        self.status = CallStatus::Connecting;
        self.append_log("status", "starting host call...");
        self.room_id_hex.clear();
        let handle = session::spawn_host(&self.runtime, settings, invite);
        self.call = Some(handle);
    }

    fn start_join(&mut self) {
        let settings = self.settings.clone();
        let room = self.room_id_hex.trim().to_string();
        if room.is_empty() {
            self.append_log("error", "paste a ROOM_ID before joining");
            return;
        }
        if settings.username.is_empty() || settings.password.is_empty() {
            self.append_log("error", "fill username + password in settings first");
            return;
        }
        self.status = CallStatus::Connecting;
        self.append_log("status", format!("joining room {room}..."));
        let handle = session::spawn_join(&self.runtime, settings, room);
        self.call = Some(handle);
    }

    fn hangup(&mut self) {
        if let Some(handle) = self.call.take() {
            let _ = handle.actions.send(SessionAction::Hangup);
            self.status = CallStatus::Idle;
            self.append_log("status", "hanging up");
        }
    }

    fn send_text(&mut self) {
        if self.chat_input.trim().is_empty() {
            return;
        }
        if let Some(handle) = self.call.as_ref() {
            if handle
                .actions
                .send(SessionAction::SendText(self.chat_input.clone()))
                .is_err()
            {
                self.append_log("error", "session is gone — can't send");
            } else {
                let echo = self.chat_input.clone();
                self.append_log("me", echo);
                self.chat_input.clear();
            }
        } else {
            self.append_log("error", "no active call");
        }
    }
}

impl eframe::App for CrocodileApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Pull events from the background session task + connect probe.
        self.drain_session_events();
        self.drain_probe();
        // Re-render continuously so chat and the level meter stay live
        // without user input. 50 ms (~20 fps) makes the meter feel
        // responsive; it is only affordable because per-frame work is
        // now cheap (device enumeration is cached, not re-queried).
        ctx.request_repaint_after(std::time::Duration::from_millis(50));

        egui::TopBottomPanel::top("tabs").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.selectable_value(&mut self.pane, Pane::Settings, "Settings");
                ui.selectable_value(&mut self.pane, Pane::Call, "Call");
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    // Call state chip.
                    let chip = match &self.status {
                        CallStatus::Idle => "idle",
                        CallStatus::Connecting => "connecting…",
                        CallStatus::Active => "in call",
                        CallStatus::Failed(_) => "failed",
                    };
                    ui.label(chip);
                    ui.separator();
                    // Connection chip.
                    if self.probing {
                        ui.label("● connecting…");
                    } else if let Some(c) = &self.connected {
                        ui.colored_label(
                            egui::Color32::from_rgb(80, 200, 120),
                            format!("● {}", c.username),
                        );
                    } else {
                        ui.colored_label(egui::Color32::GRAY, "● not connected");
                    }
                });
            });
        });

        egui::CentralPanel::default().show(ctx, |ui| match self.pane {
            Pane::Settings => self.draw_settings(ui),
            Pane::Call => self.draw_call(ui),
        });
    }
}

impl CrocodileApp {
    fn draw_settings(&mut self, ui: &mut egui::Ui) {
        ui.heading("Account");
        egui::Grid::new("account-grid")
            .num_columns(2)
            .show(ui, |ui| {
                ui.label("Server URL:");
                ui.text_edit_singleline(&mut self.settings.server);
                ui.end_row();

                ui.label("Username:");
                ui.text_edit_singleline(&mut self.settings.username);
                ui.end_row();

                ui.label("Password:");
                ui.add(egui::TextEdit::singleline(&mut self.settings.password).password(true));
                ui.end_row();

                ui.label("State dir:");
                ui.text_edit_singleline(&mut self.settings.state_dir);
                ui.end_row();
            });

        ui.add_space(8.0);
        ui.heading("Audio");
        // Populate the device cache once. Enumeration measured ~177 ms,
        // so it must never run per frame — doing so pinned the UI at a
        // few fps and made the level meter look frozen.
        if !self.audio_devices.loaded {
            self.audio_devices.refresh();
        }

        egui::Grid::new("audio-grid").num_columns(2).show(ui, |ui| {
            ui.label("Microphone:");
            device_picker(
                ui,
                "in-dev",
                &self.audio_devices.inputs,
                &mut self.settings.input_device,
            );
            ui.end_row();

            ui.label("Speakers:");
            device_picker(
                ui,
                "out-dev",
                &self.audio_devices.outputs,
                &mut self.settings.output_device,
            );
            ui.end_row();
        });
        if ui
            .small_button("\u{21bb} Rescan devices")
            .on_hover_text("Re-enumerate audio hardware (e.g. after plugging in a headset)")
            .clicked()
        {
            self.audio_devices.refresh();
        }

        // Live input meter. During a call it reflects the call's capture
        // stream; otherwise a standalone mic test can drive it, so the
        // mic is verifiable before calling anyone.
        ui.add_space(6.0);
        let call_controls = self.call.as_ref().map(|c| c.controls.clone());
        let test_controls = self.mic_test.as_ref().map(|t| t.controls.clone());
        let active = call_controls.clone().or(test_controls);

        ui.horizontal(|ui| {
            ui.label("Mic level:");
            let level = active.as_ref().map(|c| c.input_level.get()).unwrap_or(0.0);
            ui.add(
                egui::ProgressBar::new(level.min(1.0))
                    .desired_width(200.0)
                    .text(format!("{:.0}%", level * 100.0)),
            );
        });

        ui.horizontal(|ui| {
            if self.call.is_none() {
                let testing = self.mic_test.is_some();
                if ui
                    .button(if testing {
                        "Stop mic test"
                    } else {
                        "Test microphone"
                    })
                    .clicked()
                {
                    if testing {
                        // Dropping the handle closes the stop channel,
                        // ending the capture thread.
                        self.mic_test = None;
                    } else {
                        self.start_mic_test();
                    }
                }
            }
            if let Some(c) = &call_controls {
                let muted = c.is_muted();
                if ui.button(if muted { "Unmute" } else { "Mute" }).clicked() {
                    c.toggle_muted();
                }
                if muted {
                    ui.colored_label(egui::Color32::from_rgb(230, 100, 100), "muted");
                }
            }
        });

        if let Some(t) = &self.mic_test {
            if let Some(e) = &t.error {
                ui.colored_label(egui::Color32::from_rgb(230, 100, 100), format!("x {e}"));
            } else if t.controls.input_level.get() < 0.001 {
                ui.colored_label(
                    egui::Color32::from_rgb(210, 170, 90),
                    "no signal yet - speak into the mic. If it stays flat, check macOS \
                     System Settings > Privacy & Security > Microphone.",
                );
            } else {
                ui.colored_label(
                    egui::Color32::from_rgb(80, 200, 120),
                    "microphone is capturing",
                );
            }
        }

        ui.add_space(8.0);
        ui.collapsing("Network (advanced)", |ui| {
            egui::Grid::new("net-grid").num_columns(2).show(ui, |ui| {
                ui.label("Bind addr:");
                ui.text_edit_singleline(&mut self.settings.bind_addr);
                ui.end_row();
                ui.label("Advertise addr:");
                ui.text_edit_singleline(&mut self.settings.advertise_addr);
                ui.end_row();
            });
        });

        ui.add_space(8.0);
        ui.horizontal(|ui| {
            let connect_label = if self.probing {
                "Connecting…"
            } else {
                "Connect / Refresh"
            };
            if ui
                .add_enabled(!self.probing, egui::Button::new(connect_label))
                .on_hover_text(
                    "Verify this device can reach the coordination server, sign in, \
                     and load the rooms you've been invited to.",
                )
                .clicked()
            {
                self.start_connect();
            }
            if ui.button("Save settings").clicked() {
                self.settings.save();
                self.append_log("status", "settings saved");
            }
            if ui.button("Show my user_id").clicked() {
                self.start_print_id();
            }
        });

        if self.probing {
            ui.add_space(6.0);
            ui.label(format!("Connecting to {} …", self.settings.server));
        } else if let Some(c) = &self.connected {
            ui.add_space(6.0);
            ui.colored_label(
                egui::Color32::from_rgb(80, 200, 120),
                format!(
                    "✓ Connected as {} (server {}…)",
                    c.username,
                    &c.server_id_hex[..8]
                ),
            );
        } else if let Some(err) = &self.connect_error {
            ui.add_space(6.0);
            ui.colored_label(
                egui::Color32::from_rgb(230, 100, 100),
                format!("✗ Could not connect: {err}"),
            );
            // The most common cause on the server's own machine is a
            // Server URL of 127.0.0.1 while the server is bound to a LAN
            // IP — surface that hint.
            if self.settings.server.contains("127.0.0.1")
                || self.settings.server.contains("localhost")
            {
                ui.colored_label(
                    egui::Color32::from_rgb(210, 170, 90),
                    "Hint: if the server is bound to a LAN IP (BIND_ADDR=0.0.0.0:8080 \
                     or a 192.168.x address), set Server URL to that same http://<ip>:8080 \
                     — even on the machine running the server.",
                );
            }
        }

        if let Some(uid) = &self.my_user_id_hex {
            ui.add_space(8.0);
            ui.label("Share this with peers so they can invite you:");
            ui.add(egui::TextEdit::singleline(&mut uid.clone()).desired_width(f32::INFINITY));
        }
    }

    fn draw_call(&mut self, ui: &mut egui::Ui) {
        let in_call = self.call.is_some();
        ui.heading(if in_call {
            "Active call"
        } else {
            "Start or join a call"
        });

        if !in_call {
            // Gate everything behind a connection so users can't fumble
            // a call before confirming the server is reachable.
            if self.connected.is_none() {
                ui.add_space(6.0);
                ui.label("Not connected yet.");
                if ui
                    .add_enabled(!self.probing, egui::Button::new("Connect to server"))
                    .clicked()
                {
                    self.start_connect();
                }
                ui.label(
                    "Connecting verifies you can reach the coordination server and \
                     loads any rooms you've been invited to.",
                );
                return;
            }

            ui.add_space(6.0);
            ui.label("Host a call — invite someone by their username:");
            ui.horizontal(|ui| {
                ui.label("Invite username:");
                ui.text_edit_singleline(&mut self.invite_username);
                if ui.button("Host call").clicked() {
                    self.start_host();
                }
            });

            ui.add_space(12.0);
            ui.horizontal(|ui| {
                ui.label("Join a call — pick a room you were invited to:");
                if ui.small_button("↻ Refresh").clicked() {
                    self.start_connect();
                }
            });

            let rooms = self
                .connected
                .as_ref()
                .map(|c| c.rooms.clone())
                .unwrap_or_default();
            if rooms.is_empty() {
                ui.label(
                    "  (no rooms yet — either Host a call above, or have someone invite \
                     you by your username, then click Refresh)",
                );
            } else {
                for room in &rooms {
                    ui.horizontal(|ui| {
                        if ui.button(format!("Join  “{}”", room.name)).clicked() {
                            self.room_id_hex = room.room_id_hex.clone();
                            self.start_join();
                        }
                        ui.weak(format!("({})", room.role));
                        // Rooms are created per call and otherwise linger
                        // forever; owners delete, members just leave.
                        let verb = if room.role == "owner" {
                            "Delete"
                        } else {
                            "Leave"
                        };
                        if ui
                            .small_button("✖")
                            .on_hover_text(format!("{verb} this room"))
                            .clicked()
                        {
                            self.forget_room(room.room_id_hex.clone());
                        }
                    });
                }
            }
        } else {
            ui.horizontal(|ui| {
                if ui.button("Hang up").clicked() {
                    self.hangup();
                }
                if !self.room_id_hex.is_empty() {
                    ui.separator();
                    ui.label(format!("ROOM_ID (share this): {}", self.room_id_hex));
                }
            });
        }

        // Surface ROOM_ID for host as soon as the session reports it.
        if let Some(handle) = self.call.as_ref() {
            if let Ok(room) = handle.room_id.try_lock() {
                if let Some(r) = room.as_ref() {
                    if self.room_id_hex != *r {
                        self.room_id_hex = r.clone();
                    }
                }
            }
        }

        ui.separator();

        ui.label("Chat / log:");
        egui::ScrollArea::vertical()
            .stick_to_bottom(true)
            .max_height(ui.available_height() - 60.0)
            .show(ui, |ui| {
                for line in &self.log {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(egui::RichText::new(format!("[{}]", line.sender)).strong());
                        ui.label(&line.body);
                    });
                }
            });

        ui.separator();
        ui.horizontal(|ui| {
            let send_clicked = ui.add_enabled(in_call, egui::Button::new("Send")).clicked();
            let textbox = ui.add_enabled(
                in_call,
                egui::TextEdit::singleline(&mut self.chat_input).desired_width(f32::INFINITY),
            );
            let enter = textbox.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            if (send_clicked || enter) && in_call {
                self.send_text();
            }
        });
    }
}
