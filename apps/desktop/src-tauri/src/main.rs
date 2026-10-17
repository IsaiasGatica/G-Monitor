#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tauri_plugin_dialog::DialogExt;
use tauri::Manager;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session { protocol_version: u32, ws_url: String, token: String }

#[tauri::command]
fn session() -> Result<Session, String> {
    let path = std::env::var("SERIAL_MONITOR_SESSION")
        .map_err(|_| "Missing SERIAL_MONITOR_SESSION. Open the window through serial_open_ui.".to_string())?;
    let bytes = std::fs::read(path).map_err(|e| format!("Could not read the session: {e}"))?;
    let session: Session = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if session.protocol_version != 1 || !session.ws_url.starts_with("ws://127.0.0.1:") || session.token.len() != 64 {
        return Err("Invalid session".into());
    }
    Ok(session)
}

#[tauri::command]
async fn select_project_folder(app: tauri::AppHandle, current_dir: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Choose project folder");
        if let Some(dir) = current_dir.filter(|dir| std::path::Path::new(dir).is_dir()) {
            dialog = dialog.set_directory(dir);
        }
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        dialog.blocking_pick_folder().map(|folder| {
            folder.into_path().map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.to_string())
        }).transpose()
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn export_log(app: tauri::AppHandle, content: String, default_name: String) -> Result<Option<String>, String> {
    if content.len() > 64 * 1024 * 1024 {
        return Err("The log exceeds the maximum export size".into());
    }
    if default_name.len() > 80 || !default_name.ends_with(".md") ||
        !default_name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte)) {
        return Err("Invalid file name".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file()
            .set_title("Export log as Markdown")
            .set_file_name(&default_name)
            .add_filter("Markdown", &["md"]);
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let selected = dialog.blocking_save_file();
        let Some(file) = selected else { return Ok(None); };
        let path = file.into_path().map_err(|error| error.to_string())?;
        if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")) {
            return Err("Choose a file name with the .md extension".into());
        }
        std::fs::write(&path, content.as_bytes()).map_err(|error| format!("Could not save the file: {error}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }).await.map_err(|error| error.to_string())?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![session, export_log, select_project_folder])
        .run(tauri::generate_context!())
        .expect("Could not start G Monitor");
}
