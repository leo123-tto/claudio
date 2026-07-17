use std::env;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Clone, Debug)]
struct RuntimePaths {
    node: PathBuf,
    app: PathBuf,
    server: PathBuf,
    ncm: PathBuf,
    defaults: PathBuf,
    data: PathBuf,
}

impl RuntimePaths {
    fn new(resources: &Path, data: &Path) -> Self {
        let runtime = resources.join("runtime");
        let app = runtime.join("app");
        Self {
            node: runtime.join("node"),
            server: app.join("server/index.js"),
            ncm: runtime.join("ncm/start.cjs"),
            defaults: runtime.join("default-user"),
            app,
            data: data.to_path_buf(),
        }
    }
}

fn initialize_user_data(defaults: &Path, data: &Path) -> io::Result<()> {
    let user = data.join("user");
    fs::create_dir_all(&user)?;
    fs::create_dir_all(data.join("cache/tts"))?;
    fs::create_dir_all(data.join("cache/logs"))?;
    if defaults.is_dir() {
        for entry in fs::read_dir(defaults)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let target = user.join(entry.file_name());
            if !target.exists() {
                fs::copy(entry.path(), target)?;
            }
        }
    }
    Ok(())
}

fn log_file(data: &Path, name: &str) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(data.join("cache/logs").join(name))
}

fn augmented_path() -> OsString {
    let mut paths = vec![
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        paths.push(home.join(".local/bin"));
        paths.push(home.join(".cargo/bin"));
        if let Ok(versions) = fs::read_dir(home.join(".nvm/versions/node")) {
            for version in versions.flatten() {
                paths.push(version.path().join("bin"));
            }
        }
    }
    if let Some(current) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current));
    }
    env::join_paths(paths).unwrap_or_else(|_| OsString::from("/usr/bin:/bin"))
}

fn spawn_child(mut command: ProcessCommand, log: File) -> io::Result<Child> {
    let stderr = log.try_clone()?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .process_group(0)
        .spawn()
}

struct RuntimeProcesses {
    children: Mutex<Vec<Child>>,
}

impl RuntimeProcesses {
    fn start(paths: &RuntimePaths) -> io::Result<Self> {
        if !paths.node.is_file() || !paths.server.is_file() || !paths.ncm.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Claudio 内置运行时不完整",
            ));
        }
        let parent_pid = std::process::id().to_string();
        let path_env = augmented_path();

        let mut ncm_command = ProcessCommand::new(&paths.node);
        ncm_command
            .arg(&paths.ncm)
            .current_dir(paths.ncm.parent().unwrap_or(&paths.app))
            .env("PORT", "3000")
            .env("HOST", "127.0.0.1")
            .env("CLAUDIO_PARENT_PID", &parent_pid)
            .env("PATH", &path_env);
        let ncm = spawn_child(ncm_command, log_file(&paths.data, "ncm.log")?)?;

        let mut server_command = ProcessCommand::new(&paths.node);
        server_command
            .arg(&paths.server)
            .current_dir(&paths.app)
            .env("PORT", "8080")
            .env("NCM_BASE", "http://127.0.0.1:3000")
            .env("CLAUDIO_RESOURCE_ROOT", &paths.app)
            .env("CLAUDIO_DATA_DIR", &paths.data)
            .env("CLAUDIO_PARENT_PID", &parent_pid)
            .env("PATH", &path_env);
        match spawn_child(server_command, log_file(&paths.data, "claudio.log")?) {
            Ok(server) => Ok(Self {
                children: Mutex::new(vec![ncm, server]),
            }),
            Err(error) => {
                unsafe {
                    libc::kill(-(ncm.id() as i32), libc::SIGKILL);
                }
                Err(error)
            }
        }
    }

    fn stop(&self) {
        let Ok(mut locked) = self.children.lock() else {
            return;
        };
        let mut children = std::mem::take(&mut *locked);
        drop(locked);
        for child in &mut children {
            if matches!(child.try_wait(), Ok(None)) {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGTERM);
                }
            }
        }
        let deadline = Instant::now() + Duration::from_millis(1200);
        while Instant::now() < deadline {
            let any_running = children
                .iter_mut()
                .any(|child| matches!(child.try_wait(), Ok(None)));
            if !any_running {
                break;
            }
            thread::sleep(Duration::from_millis(60));
        }
        for child in &mut children {
            if matches!(child.try_wait(), Ok(None)) {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
            }
            let _ = child.wait();
        }
    }
}

fn reveal_player_when_ready(window: tauri::WebviewWindow) {
    thread::spawn(move || {
        let address: SocketAddr = "127.0.0.1:8080".parse().expect("valid local address");
        for _ in 0..120 {
            if TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok() {
                thread::sleep(Duration::from_millis(120));
                let _ = window.eval("window.location.replace('http://localhost:8080/')");
                return;
            }
            thread::sleep(Duration::from_millis(500));
        }
        let _ = window.eval("document.getElementById('status').textContent='启动没有完成，请关闭后重试。详细原因已写入本机 Claudio 日志。';document.getElementById('progress').style.display='none'");
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn initializes_default_user_files_without_overwriting_existing_data() {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("claudio-runtime-{id}"));
        let defaults = root.join("defaults");
        let data = root.join("data");
        fs::create_dir_all(&defaults).unwrap();
        fs::create_dir_all(data.join("user")).unwrap();
        fs::write(defaults.join("favorites.md"), "# 空白曲库\n").unwrap();
        fs::write(defaults.join("taste.md"), "# 默认口味\n").unwrap();
        fs::write(data.join("user/favorites.md"), "# 已有曲库\n").unwrap();

        initialize_user_data(&defaults, &data).unwrap();

        assert_eq!(
            fs::read_to_string(data.join("user/favorites.md")).unwrap(),
            "# 已有曲库\n"
        );
        assert_eq!(
            fs::read_to_string(data.join("user/taste.md")).unwrap(),
            "# 默认口味\n"
        );
        assert!(data.join("cache/tts").is_dir());
        assert!(data.join("cache/logs").is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn derives_bundled_runtime_paths_from_resource_directory() {
        let paths = RuntimePaths::new(Path::new("/bundle/Resources"), Path::new("/user/data"));
        assert_eq!(paths.node, Path::new("/bundle/Resources/runtime/node"));
        assert_eq!(
            paths.server,
            Path::new("/bundle/Resources/runtime/app/server/index.js")
        );
        assert_eq!(
            paths.ncm,
            Path::new("/bundle/Resources/runtime/ncm/start.cjs")
        );
        assert_eq!(
            paths.defaults,
            Path::new("/bundle/Resources/runtime/default-user")
        );
        assert_eq!(paths.data, Path::new("/user/data"));
    }
}

// 迷你/展开：前端 invoke 这两个 command 真正缩放 / 置顶窗口
#[tauri::command]
fn resize_window(window: tauri::Window, width: f64, height: f64) {
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
}

#[tauri::command]
fn set_on_top(window: tauri::Window, on: bool) {
    let _ = window.set_always_on_top(on);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![resize_window, set_on_top])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(runtime) = window.app_handle().try_state::<RuntimeProcesses>() {
                    runtime.stop();
                }
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let paths = RuntimePaths::new(&app.path().resource_dir()?, &app.path().app_data_dir()?);
            initialize_user_data(&paths.defaults, &paths.data)?;
            let runtime = RuntimeProcesses::start(&paths)?;
            app.manage(runtime);
            if let Some(window) = app.get_webview_window("main") {
                reveal_player_when_ready(window);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
