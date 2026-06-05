//! Top-level egui app: holds settings, the current screen, and a
//! background tokio runtime that runs the actual call session.

use std::path::PathBuf;
use std::sync::Arc;

use eframe::egui;
use tokio::runtime::Runtime;

use crate::session::{self, SessionAction, SessionEvent, SessionHandle};

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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server: "http://127.0.0.1:8080".to_string(),
            username: String::new(),
            password: String::new(),
            state_dir: "./crocodile-state".to_string(),
            bind_addr: "0.0.0.0:0".to_string(),
            advertise_addr: String::new(),
        }
    }
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
            self.append_log("error", "enter an invitee username before starting a host call");
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
        // Pull events from the background session task.
        self.drain_session_events();
        // Re-render shortly so events show up even when the user isn't
        // interacting — keeps the chat live.
        ctx.request_repaint_after(std::time::Duration::from_millis(100));

        egui::TopBottomPanel::top("tabs").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.selectable_value(&mut self.pane, Pane::Settings, "Settings");
                ui.selectable_value(&mut self.pane, Pane::Call, "Call");
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let chip = match &self.status {
                        CallStatus::Idle => "idle",
                        CallStatus::Connecting => "connecting…",
                        CallStatus::Active => "in call",
                        CallStatus::Failed(_) => "failed",
                    };
                    ui.label(chip);
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
        egui::Grid::new("account-grid").num_columns(2).show(ui, |ui| {
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
            if ui.button("Save settings").clicked() {
                self.settings.save();
                self.append_log("status", "settings saved");
            }
            if ui.button("Show my user_id").clicked() {
                self.start_print_id();
            }
        });

        if let Some(uid) = &self.my_user_id_hex {
            ui.add_space(8.0);
            ui.label("Share this with peers so they can invite you:");
            ui.add(egui::TextEdit::singleline(&mut uid.clone()).desired_width(f32::INFINITY));
        }
    }

    fn draw_call(&mut self, ui: &mut egui::Ui) {
        let in_call = self.call.is_some();
        ui.heading(if in_call { "Active call" } else { "Start or join a call" });

        if !in_call {
            ui.add_space(6.0);
            ui.label("Host a call:");
            ui.horizontal(|ui| {
                ui.label("Invite username:");
                ui.text_edit_singleline(&mut self.invite_username);
                if ui.button("Host call").clicked() {
                    self.start_host();
                }
            });

            ui.add_space(10.0);
            ui.label("Join an existing call (room id from the host):");
            ui.horizontal(|ui| {
                ui.label("ROOM_ID:");
                ui.text_edit_singleline(&mut self.room_id_hex);
                if ui.button("Join call").clicked() {
                    self.start_join();
                }
            });

            if let Some(uid) = &self.my_user_id_hex {
                ui.add_space(10.0);
                ui.label(format!("Your user_id: {uid}"));
            } else {
                ui.add_space(10.0);
                ui.label("(Visit Settings → Show my user_id to learn yours.)");
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
            let send_clicked = ui
                .add_enabled(in_call, egui::Button::new("Send"))
                .clicked();
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
