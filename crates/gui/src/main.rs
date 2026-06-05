//! Crocodile desktop GUI (egui).
//!
//! Minimal interface for the 2-peer call:
//!
//! - Settings screen: server URL, username/password, state directory,
//!   invitee (for host mode) or room id (for join mode).
//! - Home screen: shows your own user_id (for sharing with peers) and
//!   the buttons to host or join.
//! - Call screen: status, chat history, text input.
//!
//! The UI thread runs egui; a background tokio runtime drives all
//! networking. Communication between them is via mpsc channels.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use eframe::egui;

mod app;
mod session;

fn main() -> eframe::Result<()> {
    init_tracing();

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([720.0, 560.0])
            .with_min_inner_size([520.0, 400.0])
            .with_title("Crocodile"),
        ..Default::default()
    };

    eframe::run_native(
        "Crocodile",
        options,
        Box::new(|cc| Ok(Box::new(app::CrocodileApp::new(cc)))),
    )
}

fn init_tracing() {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,crocodile_gui=debug,crocodile_client=debug"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .init();
}
