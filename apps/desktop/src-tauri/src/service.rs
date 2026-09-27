use crate::control::{Control, DaemonStatus};
use objc2_foundation::{NSBundle, NSHomeDirectory, NSString};
use objc2_service_management::{SMAppService, SMAppServiceStatus};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    thread::sleep,
    time::{Duration, Instant},
};

const PLIST: &str = "com.jakdo.sky.skyd.plist";
const LABEL: &str = "com.ty91.skyd";
static SERVICE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Registration {
    NotRegistered,
    Enabled,
    RequiresApproval,
    NotFound,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostState {
    NotRegistered,
    ApprovalRequired,
    Running,
    Starting,
    Stopping,
    Stopped,
    StartupFailed,
    ConnectionFailed,
    Conflict,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    registration: Registration,
    host_state: HostState,
    daemon: Option<DaemonStatus>,
    detail: Option<String>,
    sky_home: PathBuf,
    can_manage: bool,
}

#[derive(Debug, Serialize)]
pub struct ServiceError {
    code: &'static str,
    message: String,
}

impl ServiceError {
    fn new(code: &'static str, message: impl ToString) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Status,
    Register,
    Start,
    Stop,
    Restart,
    Unregister,
    OpenSettings,
}

#[derive(Default, Debug)]
struct Job {
    program: Option<PathBuf>,
    pid: Option<u32>,
    last_exit: Option<i32>,
    app_managed: bool,
    parent_bundle: Option<String>,
}

impl Job {
    fn launching(&self) -> bool {
        self.app_managed && self.program.as_deref() == Some(Path::new("/usr/libexec/xpcproxy"))
    }
}

fn parse_job(output: &str) -> Job {
    let field = |name: &str| {
        output.lines().find_map(|line| {
            line.strip_prefix('\t')
                .and_then(|line| line.strip_prefix(&format!("{name} = ")))
                .map(str::trim)
        })
    };
    Job {
        program: field("program").map(PathBuf::from),
        pid: field("pid").and_then(|value| value.parse().ok()),
        last_exit: field("last exit code")
            .and_then(|value| value.split(':').next()?.trim().parse().ok()),
        app_managed: field("managed_by") == Some("com.apple.xpc.ServiceManagement")
            && field("program identifier")
                .is_some_and(|value| value.starts_with("Contents/MacOS/skyd (mode: ")),
        parent_bundle: field("parent bundle identifier").map(str::to_owned),
    }
}

fn classify(
    registration: Registration,
    job: Option<&Job>,
    daemon: Option<&DaemonStatus>,
) -> HostState {
    if let Some(daemon) = daemon {
        if daemon.process.state == "stopping" {
            return HostState::Stopping;
        }
        return match daemon.runtime.state.as_str() {
            "starting" => HostState::Starting,
            "draining" => HostState::Stopping,
            "ready" | "needs_configuration" | "degraded" => HostState::Running,
            _ => HostState::ConnectionFailed,
        };
    }
    match registration {
        Registration::RequiresApproval => HostState::ApprovalRequired,
        Registration::NotRegistered => HostState::NotRegistered,
        Registration::NotFound if job.is_none() => HostState::NotRegistered,
        Registration::NotFound => HostState::StartupFailed,
        Registration::Enabled => match job {
            None => HostState::Stopped,
            Some(job) if job.launching() => HostState::Starting,
            Some(job) if job.pid.is_some() => HostState::ConnectionFailed,
            Some(job) if job.last_exit.is_some_and(|code| code != 0) => HostState::StartupFailed,
            Some(_) => HostState::Starting,
        },
    }
}

struct HostService {
    home: PathBuf,
    sky_home: PathBuf,
    executable: PathBuf,
    target: String,
    bundle_identifier: String,
    control: Control,
}

impl HostService {
    fn owns_running_job(&self, job: &Job) -> bool {
        job.pid.is_some()
            && !job.launching()
            && job.app_managed
            && job.parent_bundle.as_deref() == Some(self.bundle_identifier.as_str())
            && job.program.as_ref().is_some_and(|program| {
                program
                    .canonicalize()
                    .ok()
                    .zip(self.executable.canonicalize().ok())
                    .is_some_and(|(actual, expected)| actual == expected)
            })
    }

    fn new() -> Result<Self, ServiceError> {
        let bundle = NSBundle::mainBundle();
        let contents = PathBuf::from(bundle.bundlePath().to_string()).join("Contents");
        let plist_path = contents.join("Library/LaunchAgents").join(PLIST);
        let config = plist::Value::from_file(&plist_path).map_err(|error| {
            ServiceError::new(
                "bundle_required",
                format!("설치된 Sky.app에서 실행해 주세요: {error}"),
            )
        })?;
        let home = PathBuf::from(NSHomeDirectory().to_string());
        let label = config
            .as_dictionary()
            .and_then(|dict| dict.get("Label"))
            .and_then(plist::Value::as_string)
            .ok_or_else(|| ServiceError::new("invalid_bundle", "LaunchAgent Label이 없습니다."))?;
        let bundle_identifier = bundle
            .bundleIdentifier()
            .ok_or_else(|| ServiceError::new("invalid_bundle", "앱 bundle ID가 없습니다."))?
            .to_string();
        let sky_home = config
            .as_dictionary()
            .and_then(|dict| dict.get("EnvironmentVariables"))
            .and_then(plist::Value::as_dictionary)
            .and_then(|dict| dict.get("SKY_HOME"))
            .and_then(plist::Value::as_string)
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".sky"));
        if !sky_home.is_absolute() {
            return Err(ServiceError::new(
                "invalid_home",
                "LaunchAgent의 SKY_HOME은 절대 경로여야 합니다.",
            ));
        }
        let control = Control::new(&sky_home.join("run/skyd.sock"))
            .map_err(|error| ServiceError::new("connection_failed", error))?;
        Ok(Self {
            home,
            sky_home,
            executable: contents.join("MacOS/skyd"),
            target: format!("gui/{}/{label}", unsafe { libc::getuid() }),
            bundle_identifier,
            control,
        })
    }

    fn registration(&self) -> Registration {
        let service =
            unsafe { SMAppService::agentServiceWithPlistName(&NSString::from_str(PLIST)) };
        match unsafe { service.status() } {
            SMAppServiceStatus::Enabled => Registration::Enabled,
            SMAppServiceStatus::RequiresApproval => Registration::RequiresApproval,
            SMAppServiceStatus::NotRegistered => Registration::NotRegistered,
            _ => Registration::NotFound,
        }
    }

    fn register(&self) -> Result<(), ServiceError> {
        let service =
            unsafe { SMAppService::agentServiceWithPlistName(&NSString::from_str(PLIST)) };
        unsafe { service.registerAndReturnError() }
            .map_err(|error| ServiceError::new("registration_failed", error.localizedDescription()))
    }

    fn unregister(&self) -> Result<(), ServiceError> {
        let service =
            unsafe { SMAppService::agentServiceWithPlistName(&NSString::from_str(PLIST)) };
        unsafe { service.unregisterAndReturnError() }.map_err(|error| {
            ServiceError::new("unregistration_failed", error.localizedDescription())
        })
    }

    fn job(&self) -> Result<Option<Job>, ServiceError> {
        let output = Command::new("/bin/launchctl")
            .args(["print", &self.target])
            .output()
            .map_err(|error| ServiceError::new("service_inspection_failed", error))?;
        if output.status.success() {
            let mut job = parse_job(&String::from_utf8_lossy(&output.stdout));
            if let Some(pid) = job.pid {
                let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
                let length = unsafe {
                    libc::proc_pidpath(pid as i32, buffer.as_mut_ptr().cast(), buffer.len() as u32)
                };
                if length > 0 {
                    use std::os::unix::ffi::OsStrExt;
                    let end = buffer
                        .iter()
                        .position(|byte| *byte == 0)
                        .unwrap_or(buffer.len());
                    job.program = Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..end])));
                }
            }
            Ok(Some(job))
        } else if output.status.code() == Some(113) {
            Ok(None)
        } else {
            Err(ServiceError::new(
                "service_inspection_failed",
                String::from_utf8_lossy(&output.stderr),
            ))
        }
    }

    fn conflict(&self, job: Option<&Job>) -> Option<String> {
        for directory in [
            self.home.join("Library/LaunchAgents"),
            PathBuf::from("/Library/LaunchAgents"),
        ] {
            let legacy = directory.join(format!("{LABEL}.plist"));
            if legacy.symlink_metadata().is_ok() {
                return Some(format!(
                    "기존 CLI LaunchAgent가 있습니다: {}. 기존 CLI에서 서비스를 해제한 뒤 다시 시도해 주세요. 데이터는 보존됩니다.",
                    legacy.display()
                ));
            }
        }
        if let Some(job) = job {
            let expected = self
                .executable
                .canonicalize()
                .unwrap_or_else(|_| self.executable.clone());
            let actual = job
                .program
                .as_ref()
                .map(|path| path.canonicalize().unwrap_or_else(|_| path.clone()));
            let own_idle_service = job.app_managed
                && job.parent_bundle.as_deref() == Some(self.bundle_identifier.as_str())
                && (job.pid.is_none() || job.launching());
            if actual.as_deref() != Some(expected.as_path()) && !own_idle_service {
                return Some(format!(
                    "다른 Sky 설치가 사용자 호스트 서비스를 소유하고 있습니다 ({:?}). 해당 설치에서 서비스를 해제해 주세요.",
                    actual
                ));
            }
        } else if self
            .sky_home
            .join("run/skyd.sock")
            .symlink_metadata()
            .is_ok()
        {
            return Some("관리되지 않는 호스트 또는 이전 소켓이 있습니다. 해당 호스트와 소켓 상태를 확인한 뒤 다시 시도해 주세요.".into());
        }
        let default_home = self.home.join(".sky");
        if self.sky_home != default_home
            && default_home
                .join("run/skyd.sock")
                .symlink_metadata()
                .is_ok()
        {
            return Some(
                "기본 Sky home에 다른 호스트의 소켓이 있습니다. 기존 호스트를 먼저 중지해 주세요."
                    .into(),
            );
        }
        None
    }

    fn inspect(&self) -> Result<Snapshot, ServiceError> {
        let default_target = format!("gui/{}/{LABEL}", unsafe { libc::getuid() });
        if self.target != default_target {
            let output = Command::new("/bin/launchctl")
                .args(["print", &default_target])
                .output()
                .map_err(|error| ServiceError::new("service_inspection_failed", error))?;
            if output.status.success() {
                return Err(ServiceError::new(
                    "installation_conflict",
                    "기본 Sky 서비스가 등록되어 있습니다. 별도 호스트를 동시에 시작할 수 없습니다.",
                ));
            }
            if output.status.code() != Some(113) {
                return Err(ServiceError::new(
                    "service_inspection_failed",
                    String::from_utf8_lossy(&output.stderr),
                ));
            }
        }
        let registration = self.registration();
        let job = self.job()?;
        if let Some(detail) = self.conflict(job.as_ref()) {
            return Ok(Snapshot {
                registration,
                host_state: HostState::Conflict,
                daemon: None,
                detail: Some(detail),
                sky_home: self.sky_home.clone(),
                can_manage: false,
            });
        }
        let response = validate_socket(&self.sky_home).and_then(|()| self.control.status());
        let (daemon, detail) = match response {
            Ok(daemon) if job.as_ref().and_then(|job| job.pid) == Some(daemon.process.pid) => {
                (Some(daemon), None)
            }
            Ok(_) => {
                return Ok(Snapshot {
                    registration,
                    host_state: HostState::Conflict,
                    daemon: None,
                    detail: Some("소켓 응답의 프로세스가 앱 서비스와 일치하지 않습니다.".into()),
                    sky_home: self.sky_home.clone(),
                    can_manage: false,
                });
            }
            Err(error) => (
                None,
                job.as_ref()
                    .map(|job| format!("{error} (최근 종료 코드: {:?})", job.last_exit)),
            ),
        };
        Ok(Snapshot {
            registration,
            host_state: classify(registration, job.as_ref(), daemon.as_ref()),
            daemon,
            detail,
            sky_home: self.sky_home.clone(),
            can_manage: job.as_ref().is_none_or(|job| self.owns_running_job(job)),
        })
    }

    fn assert_owned(&self) -> Result<Snapshot, ServiceError> {
        let snapshot = self.inspect()?;
        if snapshot.host_state == HostState::Conflict {
            return Err(ServiceError::new(
                "installation_conflict",
                snapshot.detail.unwrap_or_default(),
            ));
        }
        if !snapshot.can_manage {
            return Err(ServiceError::new(
                "ownership_unverified",
                "호스트 실행 경로를 아직 확인할 수 없습니다. 기동 중이면 기다려 주세요. 기동 실패가 계속되면 launchd와 등록한 앱의 경로를 확인해 주세요.",
            ));
        }
        Ok(snapshot)
    }

    fn wait_for_start(&self, previous: Option<&str>) -> Result<Snapshot, ServiceError> {
        let timeout = if previous.is_some() { 150 } else { 30 };
        let deadline = Instant::now() + Duration::from_secs(timeout);
        loop {
            let snapshot = self.inspect()?;
            if snapshot.host_state == HostState::Conflict {
                return Err(ServiceError::new(
                    "installation_conflict",
                    snapshot.detail.unwrap_or_default(),
                ));
            }
            if snapshot.registration == Registration::RequiresApproval {
                return Ok(snapshot);
            }
            if snapshot.host_state == HostState::Running
                && snapshot
                    .daemon
                    .as_ref()
                    .is_some_and(|daemon| Some(daemon.instance_id.as_str()) != previous)
            {
                return Ok(snapshot);
            }
            if Instant::now() >= deadline {
                return Err(ServiceError::new(
                    if snapshot.host_state == HostState::ConnectionFailed {
                        "connection_failed"
                    } else {
                        "startup_failed"
                    },
                    format!(
                        "호스트의 기동을 확인하지 못했습니다: {:?}. {}",
                        snapshot.host_state,
                        snapshot.detail.unwrap_or_default()
                    ),
                ));
            }
            sleep(Duration::from_millis(250));
        }
    }

    fn stop(&self) -> Result<(), ServiceError> {
        self.assert_owned()?;
        let Some(job) = self.job()? else {
            return Ok(());
        };
        let output = Command::new("/bin/launchctl")
            .args(["bootout", &self.target])
            .output()
            .map_err(|error| ServiceError::new("stop_failed", error))?;
        if !output.status.success() {
            return Err(ServiceError::new(
                "stop_failed",
                String::from_utf8_lossy(&output.stderr),
            ));
        }
        let deadline = Instant::now() + Duration::from_secs(35);
        loop {
            let alive = job
                .pid
                .is_some_and(|pid| unsafe { libc::kill(pid as i32, 0) == 0 });
            if !alive && !self.sky_home.join("run/skyd.sock").exists() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(ServiceError::new(
                    "stop_timeout",
                    "호스트 종료와 소켓 정리를 확인하지 못했습니다. 강제 종료하지 않았습니다.",
                ));
            }
            sleep(Duration::from_millis(100));
        }
    }

    fn apply(&self, action: Action) -> Result<Snapshot, ServiceError> {
        if matches!(action, Action::Status) {
            return self.inspect();
        }
        if matches!(action, Action::OpenSettings) {
            unsafe {
                SMAppService::openSystemSettingsLoginItems();
            }
            return self.inspect();
        }
        let before = self.assert_owned()?;
        match action {
            Action::Register | Action::Start => {
                if before.registration == Registration::RequiresApproval {
                    return Ok(before);
                }
                if self.job()?.is_none() {
                    if before.registration == Registration::Enabled {
                        self.unregister()?;
                    }
                    if let Err(error) = self.register() {
                        if self.registration() == Registration::RequiresApproval {
                            return self.inspect();
                        }
                        return Err(error);
                    }
                }
                self.wait_for_start(None)
            }
            Action::Stop => {
                self.stop()?;
                self.inspect()
            }
            Action::Unregister => {
                self.stop()?;
                if matches!(
                    self.registration(),
                    Registration::Enabled | Registration::RequiresApproval
                ) {
                    self.unregister()?;
                }
                self.inspect()
            }
            Action::Restart => {
                let daemon = before.daemon.ok_or_else(|| {
                    ServiceError::new(
                        "connection_failed",
                        "실행 중인 호스트에 연결할 수 없습니다.",
                    )
                })?;
                self.control
                    .restart()
                    .map_err(|error| ServiceError::new("restart_failed", error))?;
                self.wait_for_start(Some(&daemon.instance_id))
            }
            Action::Status | Action::OpenSettings => unreachable!(),
        }
    }
}

fn validate_socket(home: &Path) -> Result<(), String> {
    for (path, socket) in [
        (home.to_path_buf(), false),
        (home.join("run"), false),
        (home.join("run/skyd.sock"), true),
    ] {
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.uid() != unsafe { libc::getuid() }
            || metadata.file_type().is_symlink()
            || (socket && !metadata.file_type().is_socket())
            || (!socket && !metadata.is_dir())
        {
            return Err(format!(
                "안전하지 않은 호스트 경로입니다: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn host_service(action: Action) -> Result<Snapshot, ServiceError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SERVICE_LOCK.lock().map_err(|_| {
            ServiceError::new("native_error", "호스트 작업 잠금을 복구할 수 없습니다.")
        })?;
        HostService::new()?.apply(action)
    })
    .await
    .map_err(|error| ServiceError::new("native_error", error))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{ProcessStatus, RuntimeStatus};

    #[test]
    #[ignore = "requires an isolated signed app bundle; run test/desktop-service.smoke.mjs"]
    fn isolated_service_action() {
        let service = HostService::new().unwrap();
        let expected = PathBuf::from(std::env::var("SKY_DESKTOP_SMOKE_HOME").unwrap());
        assert!(expected.starts_with("/private/tmp") || expected.starts_with("/tmp"));
        assert_eq!(service.sky_home, expected);
        assert_ne!(service.sky_home, service.home.join(".sky"));
        let action = std::env::var("SKY_DESKTOP_SMOKE_ACTION").unwrap();
        let action: Action = serde_json::from_value(serde_json::Value::String(action)).unwrap();
        let result = service.apply(action);
        println!(
            "SKY_SERVICE_RESULT={}",
            serde_json::to_string(&result).unwrap()
        );
        assert!(result.is_ok(), "{result:?}");
    }

    #[test]
    fn registration_is_not_proof_of_a_running_host() {
        let failed = Job {
            last_exit: Some(1),
            ..Default::default()
        };
        let live = Job {
            pid: Some(42),
            ..Default::default()
        };
        assert_eq!(
            classify(Registration::Enabled, None, None),
            HostState::Stopped
        );
        assert_eq!(
            classify(Registration::Enabled, Some(&failed), None),
            HostState::StartupFailed
        );
        assert_eq!(
            classify(Registration::Enabled, Some(&live), None),
            HostState::ConnectionFailed
        );
        assert_eq!(
            classify(Registration::RequiresApproval, Some(&live), None),
            HostState::ApprovalRequired
        );
        assert_eq!(
            classify(Registration::NotRegistered, None, None),
            HostState::NotRegistered
        );
        assert_eq!(
            classify(Registration::NotFound, None, None),
            HostState::NotRegistered
        );
        assert_eq!(
            classify(Registration::NotFound, Some(&failed), None),
            HostState::StartupFailed
        );
        let mut daemon = DaemonStatus {
            instance_id: "one".into(),
            process: ProcessStatus {
                pid: 42,
                state: "running".into(),
            },
            runtime: RuntimeStatus {
                state: "needs_configuration".into(),
            },
            active_work_count: 0,
        };
        assert_eq!(
            classify(Registration::Enabled, Some(&live), Some(&daemon)),
            HostState::Running
        );
        daemon.runtime.state = "draining".into();
        assert_eq!(
            classify(Registration::Enabled, Some(&live), Some(&daemon)),
            HostState::Stopping
        );
    }

    #[test]
    fn job_identity_ignores_nested_launchctl_fields() {
        let job = parse_job(
            "gui/501/com.ty91.skyd = {\n\tprogram = /Applications/Sky.app/Contents/MacOS/skyd\n\tpid = 42\n\tlast exit code = 1\n\tproperties = {\n\t\tpid = 99\n\t}\n}",
        );
        assert_eq!(job.pid, Some(42));
        assert_eq!(job.last_exit, Some(1));
        assert_eq!(
            job.program,
            Some(PathBuf::from("/Applications/Sky.app/Contents/MacOS/skyd"))
        );
    }

    #[test]
    fn service_management_spawn_is_starting_until_xpcproxy_executes_the_host() {
        let mut job = parse_job(
            "gui/501/com.ty91.skyd = {\n\tmanaged_by = com.apple.xpc.ServiceManagement\n\tprogram identifier = Contents/MacOS/skyd (mode: 2)\n\tparent bundle identifier = com.jakdo.sky\n\tpid = 42\n}",
        );
        assert!(job.app_managed);
        job.program = Some(PathBuf::from("/usr/libexec/xpcproxy"));
        assert_eq!(
            classify(Registration::Enabled, Some(&job), None),
            HostState::Starting
        );
        job.program = Some(PathBuf::from("/Applications/Sky.app/Contents/MacOS/skyd"));
        assert_eq!(
            classify(Registration::Enabled, Some(&job), None),
            HostState::ConnectionFailed
        );
        let failed = parse_job("gui/501/com.ty91.skyd = {\n\tlast exit code = 78: EX_CONFIG\n}");
        assert_eq!(
            classify(Registration::Enabled, Some(&failed), None),
            HostState::StartupFailed
        );
    }

    #[test]
    fn blocks_legacy_registration_other_bundles_and_unmanaged_sockets() {
        let directory = tempfile::tempdir_in("/tmp").unwrap();
        let home = directory.path().to_path_buf();
        let sky_home = home.join(".sky");
        let service = HostService {
            home: home.clone(),
            sky_home: sky_home.clone(),
            executable: home.join("Sky.app/Contents/MacOS/skyd"),
            target: String::new(),
            bundle_identifier: "com.jakdo.sky".into(),
            control: Control::new(&sky_home.join("run/skyd.sock")).unwrap(),
        };
        assert!(service.conflict(None).is_none());
        fs::create_dir_all(service.executable.parent().unwrap()).unwrap();
        fs::write(&service.executable, "host").unwrap();
        let mut current = Job {
            program: Some(service.executable.clone()),
            pid: Some(42),
            app_managed: true,
            parent_bundle: Some("com.jakdo.sky".into()),
            ..Default::default()
        };
        assert!(service.owns_running_job(&current));
        current.pid = None;
        assert!(!service.owns_running_job(&current));
        current.pid = Some(42);
        current.program = Some(PathBuf::from("/usr/libexec/xpcproxy"));
        assert!(!service.owns_running_job(&current));
        let other = home.join("other/skyd");
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(&other, "other host").unwrap();
        current.program = Some(other);
        assert!(!service.owns_running_job(&current));
        assert!(
            service
                .conflict(Some(&Job {
                    program: Some(home.join("other/skyd")),
                    ..Default::default()
                }))
                .is_some()
        );
        assert!(
            service
                .conflict(Some(&Job {
                    program: Some(service.executable.clone()),
                    ..Default::default()
                }))
                .is_none()
        );
        fs::create_dir_all(sky_home.join("run")).unwrap();
        let socket =
            std::os::unix::net::UnixListener::bind(sky_home.join("run/skyd.sock")).unwrap();
        assert!(service.conflict(None).unwrap().contains("소켓"));
        drop(socket);
        fs::remove_file(sky_home.join("run/skyd.sock")).unwrap();
        let agents = home.join("Library/LaunchAgents");
        fs::create_dir_all(&agents).unwrap();
        fs::write(agents.join(format!("{LABEL}.plist")), "legacy").unwrap();
        assert!(service.conflict(None).unwrap().contains("CLI"));
    }

    #[test]
    fn refuses_symlinked_socket_directories() {
        let directory = tempfile::tempdir_in("/tmp").unwrap();
        let home = directory.path().join("home");
        fs::create_dir(&home).unwrap();
        std::os::unix::fs::symlink(directory.path(), home.join("run")).unwrap();
        assert!(
            validate_socket(&home)
                .unwrap_err()
                .contains("안전하지 않은")
        );
    }
}
