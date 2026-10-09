//! Kapi runtime — Rust side. Kept deliberately small: file access, .petpack import, tray.
//! All pet behaviour lives in the webview (src/main.js).

use serde::Serialize;
use std::{fs, io::Read, path::PathBuf};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

#[derive(Serialize, Clone)]
pub struct PetInfo {
    pub id: String,
    pub name: String,
    pub version: u64,
    pub dir: String,
}

fn pets_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.join("pets"));
            // macOS: Kapi.app/Contents/MacOS/Kapi -> folder beside the .app bundle
            if let Some(app_dir) = dir.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
                roots.push(app_dir.join("pets"));
            }
        }
    }
    if let Ok(data) = app.path().app_data_dir() {
        roots.push(data.join("pets"));
    }
    roots
}

#[tauri::command]
fn list_pets(app: AppHandle) -> Vec<PetInfo> {
    let mut found: Vec<PetInfo> = Vec::new();
    for root in pets_roots(&app) {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for e in entries.flatten() {
            let dir = e.path();
            let Ok(text) = fs::read_to_string(dir.join("pet.json")) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            let id = v["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            let version = v["version"].as_u64().unwrap_or(1);
            let name = v["name"].as_str().unwrap_or(&id).to_string();
            let dir_s = dir.to_string_lossy().to_string();
            match found.iter_mut().find(|p| p.id == id) {
                Some(existing) if existing.version < version => {
                    existing.version = version;
                    existing.dir = dir_s;
                    existing.name = name;
                }
                Some(_) => {}
                None => found.push(PetInfo { id, name, version, dir: dir_s }),
            }
        }
    }
    found
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// Read an image as a data: URL so the canvas stays same-origin (asset:// images taint the canvas on Windows).
#[tauri::command]
fn read_file_b64(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let mime = match PathBuf::from(&path).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png", Some("webp") => "image/webp", Some("jpg") | Some("jpeg") => "image/jpeg", Some("gif") => "image/gif", Some("mp3") => "audio/mpeg", Some("wav") => "audio/wav", Some("ogg") => "audio/ogg", _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_path(app: AppHandle) -> Result<String, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(data.join("settings.json").to_string_lossy().to_string())
}

/// Unzip a .petpack (zip whose top-level folder is the pet id) into app_data/pets/<id>.
#[tauri::command]
fn import_pet(app: AppHandle, path: String) -> Result<PetInfo, String> {
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut prefix = String::new();
    let mut manifest = String::new();
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        if name.ends_with("pet.json") && name.matches('/').count() <= 1 {
            prefix = name.trim_end_matches("pet.json").to_string();
            f.read_to_string(&mut manifest).map_err(|e| e.to_string())?;
            break;
        }
    }
    if manifest.is_empty() {
        return Err("not a pet package (pet.json not found at top level)".into());
    }
    let v: serde_json::Value = serde_json::from_str(&manifest).map_err(|e| e.to_string())?;
    let id = v["id"].as_str().ok_or("pet.json has no id")?.to_string();
    let version = v["version"].as_u64().unwrap_or(1);
    let name = v["name"].as_str().unwrap_or(&id).to_string();
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let target = data.join("pets").join(&id);
    // Preserve the pet's progress when an update moves a portable pet into app data.
    // The package contains assets and behavior, but the local state belongs to the user.
    let previous_state = std::iter::once(target.clone())
        .chain(pets_roots(&app).into_iter().map(|root| root.join(&id)))
        .find_map(|dir| fs::read(dir.join("state.json")).ok());
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        let Some(rel) = name.strip_prefix(&prefix) else { continue };
        if rel.is_empty() || rel.contains("..") {
            continue;
        }
        let out = target.join(rel);
        if f.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            fs::write(&out, buf).map_err(|e| e.to_string())?;
        }
    }
    if let Some(state) = previous_state {
        fs::write(target.join("state.json"), state).map_err(|e| e.to_string())?;
    }
    Ok(PetInfo { id, name, version, dir: target.to_string_lossy().to_string() })
}

/// Zip app_data/pets/<id> back into a .petpack so the user can send it to the skill for the next step.
#[tauri::command]
fn export_pet(dir: String, out_path: String) -> Result<(), String> {
    let src = PathBuf::from(&dir);
    let id = src.file_name().ok_or("bad dir")?.to_string_lossy().to_string();
    let file = fs::File::create(&out_path).map_err(|e| e.to_string())?;
    let mut zw = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    fn walk(zw: &mut zip::ZipWriter<fs::File>, opts: zip::write::SimpleFileOptions, base: &PathBuf, dir: &PathBuf, id: &str) -> Result<(), String> {
        for e in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(zw, opts, base, &p, id)?;
            } else {
                let rel = p.strip_prefix(base).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
                zw.start_file(format!("{id}/{rel}"), opts).map_err(|e| e.to_string())?;
                let data = fs::read(&p).map_err(|e| e.to_string())?;
                std::io::Write::write_all(zw, &data).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    walk(&mut zw, opts, &src, &src, &id)?;
    zw.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct WinRect { pub x: f64, pub y: f64, pub w: f64, pub h: f64, pub title: String, pub app: String }

/// Rect of the foreground window (physical px), or null. Used for "sit on the active window".
#[tauri::command]
fn active_window() -> Option<WinRect> {
    match active_win_pos_rs::get_active_window() {
        Ok(w) => Some(WinRect { x: w.position.x, y: w.position.y, w: w.position.width, h: w.position.height, title: w.title, app: w.app_name }),
        Err(_) => None,
    }
}

#[derive(Serialize, Clone)]
pub struct BatteryInfo { pub percent: f32, pub charging: bool }

#[tauri::command]
fn battery_status() -> Option<BatteryInfo> {
    let manager = battery::Manager::new().ok()?;
    let bat = manager.batteries().ok()?.next()?.ok()?;
    let percent: f32 = bat.state_of_charge().get::<battery::units::ratio::percent>();
    let charging = matches!(bat.state(), battery::State::Charging | battery::State::Full);
    Some(BatteryInfo { percent, charging })
}

/// Open another pet in its own window (label pet-<id>). The page reads ?pet=<id>.
#[tauri::command]
fn open_pet_window(app: AppHandle, id: String) -> Result<(), String> {
    let label = format!("pet-{}", id.replace(|c: char| !c.is_ascii_alphanumeric(), "-"));
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    let url = tauri::WebviewUrl::App(format!("index.html?pet={id}").into());
    tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title("Kapi").inner_size(360.0, 480.0).transparent(true).decorations(false).shadow(false)
        .always_on_top(true).skip_taskbar(true).resizable(false).accept_first_mouse(true).visible_on_all_workspaces(true)
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Global input watcher: counts key presses without reading text and reports Ctrl transitions for pet gestures.
fn spawn_input_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        use device_query::{DeviceQuery, DeviceState};
        let dev = DeviceState::new();
        let mut last_keys: Vec<device_query::Keycode> = Vec::new();
        let mut last_mouse = (0i32, 0i32);
        let mut presses = 0u32;
        let mut last_ctrl = false;
        let mut window_start = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(80));
            let keys = dev.get_keys();
            let ctrl = keys.contains(&device_query::Keycode::LControl) || keys.contains(&device_query::Keycode::RControl);
            if ctrl != last_ctrl {
                let _ = app.emit("modifier-state", serde_json::json!({ "ctrl": ctrl }));
                last_ctrl = ctrl;
            }
            for k in &keys {
                if !last_keys.contains(k) && !matches!(k, device_query::Keycode::LControl | device_query::Keycode::RControl | device_query::Keycode::LShift | device_query::Keycode::RShift | device_query::Keycode::LAlt | device_query::Keycode::RAlt | device_query::Keycode::LMeta | device_query::Keycode::RMeta) {
                    presses += 1;
                }
            }
            last_keys = keys;
            let m = dev.get_mouse().coords;
            let mouse_moved = m != last_mouse;
            last_mouse = m;
            if window_start.elapsed().as_millis() >= 1000 {
                if presses > 0 || mouse_moved {
                    let _ = app.emit("user-input", serde_json::json!({ "keys": presses, "mouse": mouse_moved }));
                }
                presses = 0;
                window_start = std::time::Instant::now();
            }
        }
    });
}


// ---------------- Capafy connection: keychain + relay API (SSE) ----------------
const CAPAFY_API: &str = "https://api.capafy.ai";
const KEYRING_SERVICE: &str = "app.kapi.deskpet";

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?.set_password(&value).map_err(|e| e.to_string())
}
#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    match keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    match keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize, Clone)]
pub struct ApiResult { pub status: u16, pub body: serde_json::Value }

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default()
}

/// GET https://api.capafy.ai{path} with the user's token. Never logs the token.
#[tauri::command]
async fn capafy_get(path: String, token: String) -> Result<ApiResult, String> {
    if !path.starts_with('/') { return Err("path must start with /".into()); }
    let resp = client().get(format!("{CAPAFY_API}{path}")).bearer_auth(token).header("Accept", "application/json")
        .send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let body = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
    Ok(ApiResult { status, body })
}

#[tauri::command]
async fn capafy_post(path: String, token: String, body: serde_json::Value) -> Result<ApiResult, String> {
    if !path.starts_with('/') { return Err("path must start with /".into()); }
    let resp = client().post(format!("{CAPAFY_API}{path}")).bearer_auth(token).header("Accept", "application/json")
        .json(&body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let b = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
    Ok(ApiResult { status, body: b })
}

#[derive(Serialize, Clone)]
struct PetChatEvent { request_id: String, kind: String, content: String, seq: i64, status: u16 }

fn emit_chat(app: &AppHandle, request_id: &str, kind: &str, content: &str, seq: i64, status: u16) {
    let _ = app.emit("petchat", PetChatEvent { request_id: request_id.to_string(), kind: kind.to_string(), content: content.to_string(), seq, status });
}

/// Consume an SSE body, emitting message/done/timeout events. Lenient about the exact event schema.
async fn pump_sse(app: &AppHandle, request_id: &str, resp: reqwest::Response) {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let (mut ev, mut data) = (String::new(), String::new());
    let mut got_done = false;
    while let Some(chunk) = stream.next().await {
        let Ok(bytes) = chunk else { break };
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim_end_matches('\r').to_string();
            buf.drain(..=pos);
            if line.is_empty() {
                if !data.is_empty() || !ev.is_empty() {
                    let kind = if ev.is_empty() { "message".to_string() } else { ev.clone() };
                    let (content, seq) = match serde_json::from_str::<serde_json::Value>(&data) {
                        Ok(v) => (
                            v.get("content").and_then(|c| c.as_str()).map(|s| s.to_string())
                                .or_else(|| v.get("text").and_then(|c| c.as_str()).map(|s| s.to_string()))
                                .or_else(|| v.get("delta").and_then(|c| c.as_str()).map(|s| s.to_string()))
                                .unwrap_or_default(),
                            v.get("seq").and_then(|s| s.as_i64()).unwrap_or(-1),
                        ),
                        Err(_) => (data.clone(), -1),
                    };
                    let k = if kind == "done" || data.trim() == "[DONE]" { "done" } else if kind == "timeout" { "timeout" } else if kind == "error" { "error" } else { "message" };
                    emit_chat(app, request_id, k, &content, seq, 200);
                    if k == "done" { got_done = true; }
                }
                ev.clear(); data.clear();
                continue;
            }
            if let Some(v) = line.strip_prefix("event:") { ev = v.trim().to_string(); }
            else if let Some(v) = line.strip_prefix("data:") { if !data.is_empty() { data.push('\n'); } data.push_str(v.trim_start()); }
        }
    }
    if !got_done { emit_chat(app, request_id, "done", "", -1, 200); }
}

/// POST /agent/relay/instances/{id}/messages and stream the reply as `petchat` events.
#[tauri::command]
async fn relay_send(app: AppHandle, instance_id: String, token: String, content: String, request_id: String) -> Result<(), String> {
    let url = format!("{CAPAFY_API}/agent/relay/instances/{instance_id}/messages");
    let resp = client().post(url).bearer_auth(token).header("Accept", "text/event-stream, application/json")
        .json(&serde_json::json!({ "content": content })).send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if status >= 400 {
        let text = resp.text().await.unwrap_or_default();
        emit_chat(&app, &request_id, "error", &text.chars().take(600).collect::<String>(), -1, status);
        return Ok(());
    }
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if ct.contains("text/event-stream") {
        pump_sse(&app, &request_id, resp).await;
    } else {
        let text = resp.text().await.unwrap_or_default();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text.clone()));
        let content = v.get("content").and_then(|c| c.as_str()).or_else(|| v.get("reply").and_then(|c| c.as_str())).map(|s| s.to_string()).unwrap_or(text);
        emit_chat(&app, &request_id, "message", &content, 0, status);
        emit_chat(&app, &request_id, "done", "", 1, status);
    }
    Ok(())
}

#[tauri::command]
async fn relay_reconnect(app: AppHandle, instance_id: String, token: String, request_id: String) -> Result<(), String> {
    let url = format!("{CAPAFY_API}/agent/relay/instances/{instance_id}/messages/reconnect");
    let resp = client().post(url).bearer_auth(token).header("Accept", "text/event-stream, application/json")
        .json(&serde_json::json!({})).send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if status >= 400 { emit_chat(&app, &request_id, "error", "", -1, status); return Ok(()); }
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if ct.contains("text/event-stream") { pump_sse(&app, &request_id, resp).await; }
    else {
        let text = resp.text().await.unwrap_or_default();
        emit_chat(&app, &request_id, "message", &text, 0, status);
        emit_chat(&app, &request_id, "done", "", 1, status);
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_pets, read_text, read_file_b64, write_text, settings_path, import_pet, export_pet,
            active_window, battery_status, open_pet_window,
            secret_set, secret_get, secret_delete, capafy_get, capafy_post, relay_send, relay_reconnect
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
            let import = MenuItem::with_id(app, "import", "导入宠物包 (.petpack)…", true, None::<&str>)?;
            let switch = MenuItem::with_id(app, "switch", "切换宠物", true, None::<&str>)?;
            let export = MenuItem::with_id(app, "export", "导出当前宠物包…", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show, &import, &switch, &export, &PredefinedMenuItem::separator(app)?, &settings, &quit],
            )?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("Kapi")
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref().to_string();
                    if id == "quit" {
                        app.exit(0);
                    } else {
                        let _ = app.emit("tray", id);
                    }
                })
                .build(app)?;
            if let Some(w) = app.get_webview_window("pet") {
                let _ = w.set_visible_on_all_workspaces(true);
            }
            spawn_input_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Kapi");
}
