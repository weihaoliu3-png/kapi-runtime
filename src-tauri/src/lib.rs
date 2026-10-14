//! Kapi runtime — Rust side. Kept deliberately small: file access, .petpack import, tray.
//! All pet behaviour lives in the webview (src/main.js).

use serde::Serialize;
use std::{fs, io::Read, path::PathBuf};
use fs4::fs_std::FileExt;
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

/// Where this copy is running from, and whether macOS moved it (0.9.5). An unsigned, quarantined .app opened straight
/// from Downloads is run by Gatekeeper from a random READ-ONLY path (App Translocation), so the `pets/` folder next to
/// the .app is invisible and the pet "disappears". We cannot undo that from inside the app — but we can say so.
#[derive(Serialize, Clone)]
pub struct LaunchInfo {
    #[serde(rename = "exeDir")]
    pub exe_dir: String,
    pub folder: String,
    pub translocated: bool,
    pub roots: Vec<String>,
}

#[tauri::command]
fn launch_info(app: AppHandle) -> LaunchInfo {
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_dir = exe.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let translocated = exe_dir.contains("AppTranslocation");
    LaunchInfo {
        exe_dir,
        folder: exe_folder().to_string_lossy().to_string(),
        translocated,
        roots: pets_roots(&app).iter().map(|p| p.to_string_lossy().to_string()).collect(),
    }
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

/// bundle.json next to the executable (or beside the .app): written by the skill's first-delivery packaging so the
/// runtime can activate the delivered pet once. None when there is no bundle file.
#[tauri::command]
fn bundle_info() -> Option<serde_json::Value> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let mut cands = vec![dir.join("bundle.json")];
    if let Some(app_dir) = dir.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
        cands.push(app_dir.join("bundle.json"));
    }
    for c in cands {
        if let Ok(txt) = fs::read_to_string(&c) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                return Some(v);
            }
        }
    }
    None
}

/// The folder this Kapi lives in (beside Kapi.exe; beside Kapi.app on macOS). One pet per folder (0.8.16): the lock,
/// the settings and the default pet are all per folder, so two copies in two folders are two independent pets.
fn exe_folder() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        if dir.ends_with("Contents/MacOS") {
            if let Some(app_dir) = dir.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) { return app_dir.to_path_buf(); }
        }
    }
    dir
}
fn folder_key() -> String {
    // short stable hash of the folder path (no external crate)
    let s = exe_folder().to_string_lossy().to_lowercase();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
    format!("{:016x}", h)
}

#[tauri::command]
fn settings_path(app: AppHandle) -> Result<String, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let per = data.join(format!("settings-{}.json", folder_key()));
    if !per.exists() {
        // first run of 0.8.16 in this folder: inherit the old shared settings so nothing the user set is lost
        let old = data.join("settings.json");
        if old.exists() { let _ = fs::create_dir_all(&data); let _ = fs::copy(&old, &per); }
    }
    Ok(per.to_string_lossy().to_string())
}

/// Peers (0.8.16): every running Kapi writes its pet's rect to <temp>/kapi-peers/<folderkey>.json about once a second
/// and reads the others', so two pets in two processes still greet each other. Stale files (>4 s) are ignored.
#[derive(Serialize, serde::Deserialize, Clone)]
pub struct Peer { pub key: String, pub id: String, pub name: String, pub rect: serde_json::Value, pub t: u64 }
fn peers_dir() -> PathBuf { std::env::temp_dir().join("kapi-peers") }
#[tauri::command]
fn peer_pets(id: String, name: String, rect: serde_json::Value) -> Vec<Peer> {
    let dir = peers_dir(); let _ = fs::create_dir_all(&dir);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let me = Peer { key: folder_key(), id, name, rect, t: now };
    let _ = fs::write(dir.join(format!("{}.json", me.key)), serde_json::to_vec(&me).unwrap_or_default());
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            if let Ok(txt) = fs::read_to_string(e.path()) {
                if let Ok(p) = serde_json::from_str::<Peer>(&txt) {
                    if p.key == me.key { continue; }
                    if now.saturating_sub(p.t) > 4 { let _ = fs::remove_file(e.path()); continue; }
                    out.push(p);
                }
            }
        }
    }
    out
}

/// Append one line to <app_data>/kapi-debug.log from the native side (the page's own logger needs a working IPC;
/// when the bug is "the IPC froze" only this one tells the story).
fn native_log(app: &AppHandle, line: &str) {
    if let Ok(data) = app.path().app_data_dir() {
        let _ = fs::create_dir_all(&data);
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(data.join("kapi-debug.log")) {
            use std::io::Write;
            let _ = writeln!(f, "{} native {}", stamp, line);
        }
    }
}

/// 0.9.3 (Windows 小本子白屏 + 桌宠永久失去鼠标, 0.9.2 still reproduced): the notebook is no longer CREATED at
/// runtime at all. It is declared in tauri.conf.json next to the pet window (hidden), so it is built by the same
/// start-up path that demonstrably works, and opening it is only "tell the page which pet, show, focus". The
/// command is `async` so it runs on a worker thread and can never sit inside the main-thread IPC handler
/// (WebviewWindowBuilder::build from a sync command deadlocks WebView2 on Windows — that was 0.9.1; 0.9.2's
/// run_on_main_thread closure was still built from inside the event loop's own callback). If the window is
/// somehow missing, it is built from this worker thread (the documented-safe way) and reported either way.
#[tauri::command]
async fn open_panel_window(app: AppHandle, pet_dir: String, lang: String) -> Result<(), String> {
    native_log(&app, "notebook-click");
    let payload = serde_json::json!({ "dir": pet_dir, "lang": lang });
    let w = match app.get_webview_window("notebook") {
        Some(w) => w,
        None => {
            native_log(&app, "notebook window missing — building from worker thread");
            match tauri::WebviewWindowBuilder::new(&app, "notebook", tauri::WebviewUrl::App("panel.html".into()))
                .title("Kapi").inner_size(560.0, 640.0).min_inner_size(420.0, 480.0).resizable(true).decorations(true).always_on_top(false).visible(false)
                .build() {
                Ok(w) => { native_log(&app, "window-created notebook"); w }
                Err(e) => { native_log(&app, &format!("load-error notebook build: {}", e)); let _ = app.emit("aux-window", serde_json::json!({ "label": "notebook", "ok": false, "error": e.to_string() })); return Err(e.to_string()); }
            }
        }
    };
    let _ = app.emit_to(tauri::EventTarget::labeled("notebook"), "notebook-open", payload.clone());
    let _ = app.emit("notebook-open", payload);      // the page also listens app-wide, in case emit_to races the hidden webview
    let r1 = w.show(); let r2 = w.set_focus(); let _ = w.unminimize();
    native_log(&app, &format!("window-shown notebook show={:?} focus={:?}", r1.is_ok(), r2.is_ok()));
    let _ = app.emit("aux-window", serde_json::json!({ "label": "notebook", "ok": true }));
    Ok(())
}
/// Hide (never destroy) the notebook: it is reused for the whole run.
#[tauri::command]
async fn close_panel_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("notebook") { let _ = w.hide(); native_log(&app, "notebook hidden"); }
    Ok(())
}
/// One Kapi per folder (0.8.16): an exclusive lock on <folder>/.kapi.lock held for the whole run. A second launch
/// from the same folder cannot take it: it touches <folder>/.kapi.show so the running one shows itself, and exits.
/// A Kapi in another folder has its own lock and runs independently — that is how two pets share a desktop.
fn take_folder_lock() -> bool {
    let dir = exe_folder();
    let path = dir.join(".kapi.lock");
    let file = match fs::OpenOptions::new().read(true).write(true).create(true).open(&path) {
        Ok(f) => f,
        Err(_) => return true,     // read-only folder: cannot lock, run anyway
    };
    match file.try_lock_exclusive() {
        Ok(true) => { std::mem::forget(file); true }                 // fs4 0.13: Ok(false) = someone else holds it
        _ => { let _ = fs::write(dir.join(".kapi.show"), b"1"); false }
    }
}
fn spawn_show_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let flag = exe_folder().join(".kapi.show");
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            if flag.exists() {
                let _ = fs::remove_file(&flag);
                if let Some(w) = app.get_webview_window("pet") { let _ = w.show(); let _ = w.set_ignore_cursor_events(false); let _ = w.set_focus(); }
                let _ = app.emit("tray", "recover");
            }
        }
    });
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

/// Accessibility (macOS only, 0.9.1). The global input watcher needs the Accessibility permission on macOS, and
/// `device_query::DeviceState::new()` both PROMPTS for it and panics without it. So on macOS the watcher starts only
/// when the permission is already granted (checked WITHOUT a prompt), a background check every 5 s starts it the
/// moment the user grants it, and the prompt itself is shown only from the tray item「启用打字互动」. Everything
/// else about the pet works without the permission; typing reactions, the flower and the Ctrl whip simply wait.
static INPUT_WATCHER_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(target_os = "macos")]
fn input_permission_granted() -> bool { macos_accessibility_client::accessibility::application_is_trusted() }
#[cfg(not(target_os = "macos"))]
fn input_permission_granted() -> bool { true }

/// Start the watcher if allowed; never prompts. Returns whether it is (now) running.
fn start_input_watcher_if_allowed(app: &AppHandle) -> bool {
    if INPUT_WATCHER_RUNNING.load(std::sync::atomic::Ordering::SeqCst) { return true; }
    if !input_permission_granted() { let _ = app.emit("input-watcher", serde_json::json!({ "active": false, "reason": "accessibility" })); return false; }
    INPUT_WATCHER_RUNNING.store(true, std::sync::atomic::Ordering::SeqCst);
    spawn_input_watcher(app.clone());
    let _ = app.emit("input-watcher", serde_json::json!({ "active": true }));
    true
}
/// macOS: keep checking so a permission granted in System Settings takes effect without a restart.
fn spawn_permission_poll(app: AppHandle) {
    if input_permission_granted() { return; }
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        if start_input_watcher_if_allowed(&app) { break; }
    });
}
/// Tray「启用打字互动」: show the system prompt once (this also lists Kapi under Accessibility) and open the pane.
#[tauri::command]
fn request_input_permission(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        let granted = macos_accessibility_client::accessibility::application_is_trusted_with_prompt();
        if !granted {
            let _ = std::process::Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").spawn();
            spawn_permission_poll(app.clone());
        }
        return start_input_watcher_if_allowed(&app) || granted;
    }
    #[cfg(not(target_os = "macos"))]
    { start_input_watcher_if_allowed(&app) }
}
#[tauri::command]
fn input_watcher_state() -> serde_json::Value {
    serde_json::json!({ "active": INPUT_WATCHER_RUNNING.load(std::sync::atomic::Ordering::SeqCst), "granted": input_permission_granted(), "macos": cfg!(target_os = "macos") })
}

/// Global input watcher: counts key presses without reading text and reports Ctrl transitions for pet gestures.
/// Only ever started through start_input_watcher_if_allowed (one thread, permission already granted).
fn spawn_input_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        use device_query::{DeviceQuery, DeviceState};
        #[cfg(target_os = "macos")]
        let dev = match DeviceState::checked_new() { Some(d) => d, None => { INPUT_WATCHER_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst); return; } };
        #[cfg(not(target_os = "macos"))]
        let dev = DeviceState::new();
        let mut last_keys: Vec<device_query::Keycode> = Vec::new();
        let mut last_mouse = (0i32, 0i32);
        let mut presses = 0u32;
        let mut last_ctrl = false;
        let (mut last_left, mut last_right) = (false, false);
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
            let mouse = dev.get_mouse();
            let m = mouse.coords;
            let mouse_moved = m != last_mouse;
            last_mouse = m;
            // 0.8.16 mouse events (no content, only "a button went down where"): left / right presses with their
            // screen position, plus a fast-move flag, so the pet can glance at what the user is doing on the desktop
            let left = mouse.button_pressed.get(1).copied().unwrap_or(false);
            let right = mouse.button_pressed.get(2).copied().unwrap_or(false);
            if left && !last_left { let _ = app.emit("mouse-press", serde_json::json!({ "button": "left", "x": m.0, "y": m.1 })); }
            if right && !last_right { let _ = app.emit("mouse-press", serde_json::json!({ "button": "right", "x": m.0, "y": m.1 })); }
            last_left = left; last_right = right;
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


pub fn run() {
    if !take_folder_lock() { return; }     // this folder's Kapi is already running: it has been asked to show itself
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_pets, read_text, read_file_b64, write_text, settings_path, bundle_info, import_pet, export_pet,
            active_window, battery_status, peer_pets, open_panel_window, close_panel_window, request_input_permission, input_watcher_state, launch_info
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
            let import = MenuItem::with_id(app, "import", "导入宠物包 (.petpack)…", true, None::<&str>)?;
            let switch = MenuItem::with_id(app, "switch", "切换宠物", true, None::<&str>)?;
            let export = MenuItem::with_id(app, "export", "导出当前宠物包…", true, None::<&str>)?;
            let notebook = MenuItem::with_id(app, "notebook", "它的小本子", true, None::<&str>)?;
            #[cfg(target_os = "macos")]
            let typing = MenuItem::with_id(app, "typing", "启用打字互动（需要辅助功能权限）", true, None::<&str>)?;
            let recover = MenuItem::with_id(app, "recover", "恢复交互（点不动时）", true, None::<&str>)?;
            let diagnose = MenuItem::with_id(app, "diagnose", "诊断（出问题时点这个，再把日志发来）", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show, &notebook, #[cfg(target_os = "macos")] &typing, &import, &switch, &export, &PredefinedMenuItem::separator(app)?, &recover, &diagnose, &PredefinedMenuItem::separator(app)?, &quit],
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
                    } else if id == "recover" {
                        // belt and braces from the native side too: the pet window may never stay click-through
                        if let Some(w) = app.get_webview_window("pet") { let _ = w.set_ignore_cursor_events(false); }
                        let _ = app.emit("tray", id);
                    } else {
                        let _ = app.emit("tray", id);
                    }
                })
                .build(app)?;
            if let Some(w) = app.get_webview_window("pet") {
                let _ = w.set_visible_on_all_workspaces(true);
            }
            start_input_watcher_if_allowed(app.handle());      // never prompts; macOS without the permission just runs without typing reactions
            spawn_permission_poll(app.handle().clone());
            spawn_show_watcher(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // the notebook is reused for the whole run: closing it only hides it (the pet window is never closed this way)
            if window.label() == "notebook" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = window.hide(); native_log(window.app_handle(), "notebook close → hidden"); }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Kapi");
}
