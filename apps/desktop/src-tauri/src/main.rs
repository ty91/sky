mod control;
mod service;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostBuild {
    version: String,
    target: String,
    revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildInfo {
    app_version: String,
    host_version: String,
    target: String,
    revision: String,
    mode: &'static str,
}

#[tauri::command]
fn build_info(app: tauri::AppHandle) -> Result<BuildInfo, String> {
    let path = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("build-info.json");
    let contents = std::fs::read(path).map_err(|error| error.to_string())?;
    let host: HostBuild = serde_json::from_slice(&contents).map_err(|error| error.to_string())?;
    Ok(BuildInfo {
        app_version: app.package_info().version.to_string(),
        host_version: host.version,
        target: host.target,
        revision: host.revision,
        mode: if tauri::is_dev() {
            "development"
        } else {
            "bundle"
        },
    })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![build_info, service::host_service])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Sky")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Reopen { .. })
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.show();
                let _ = window.set_focus();
            }
        });
}
