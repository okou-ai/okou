//! Opt-in KVM study. Never called by Runner admission; see docs/workspace-handoff-study.md.
use std::error::Error;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sandbox::{
    BlockRateLimits, DeviceRateLimits, EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecResult,
    ExecTermination, FactoryConfig, GuestStateRestoreRequest, GuestStateRestoreTimezone,
    NetworkRateLimits, ResourceLimits, RuntimeConfig, Sandbox, SandboxConfig, SandboxFactory,
    SandboxId, SandboxParkOutcome, SandboxRuntime, SnapshotCreateConfig, SnapshotRef,
    WorkspaceDriveConfig, WorkspaceDriveSeedImage,
};
use sandbox_firecracker::{FirecrackerRuntime, RuntimePaths, SockPaths, create_snapshot};
use serde::Deserialize;
use serde_json::{Map, Value, json};

type StudyResult<T> = Result<T, Box<dyn Error + Send + Sync>>;
const DEADLINE: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
struct Config {
    binary: PathBuf,
    kernel: PathBuf,
    rootfs: PathBuf,
    vcpu: u32,
    memory_mb: u32,
    disk_mb: u32,
}

fn record(value: Value) {
    println!("{value}");
}

fn checked(result: ExecResult) -> StudyResult<Vec<u8>> {
    if result.termination != (ExecTermination::Exited { exit_code: 0 })
        || result.stdout_truncated
        || result.stderr_truncated
    {
        return Err(format!(
            "guest {:?}: {} {}",
            result.termination,
            String::from_utf8_lossy(&result.stderr),
            result.diagnostic
        )
        .into());
    }
    Ok(result.stdout)
}

async fn exec(vm: &dyn Sandbox, command: &str) -> StudyResult<Vec<u8>> {
    checked(
        vm.exec(&ExecRequest {
            cmd: command,
            timeout: DEADLINE,
            env: &[],
            sudo: true,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await?,
    )
}

async fn restore(vm: &dyn Sandbox) -> StudyResult<()> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?;
    let mut entropy = [0_u8; 256];
    File::open("/dev/urandom")?.read_exact(&mut entropy)?;
    checked(
        vm.restore_guest_state(&GuestStateRestoreRequest {
            unix_seconds: now.as_secs(),
            unix_nanoseconds: now.subsec_nanos(),
            entropy: &entropy,
            timezone: GuestStateRestoreTimezone::Required("UTC"),
            timeout: DEADLINE,
        })
        .await?,
    )?;
    Ok(())
}

fn limits() -> DeviceRateLimits {
    DeviceRateLimits {
        block: BlockRateLimits {
            bandwidth_bytes_per_sec: 100 * 1024 * 1024,
            ops_per_sec: 10_000,
        },
        network: NetworkRateLimits {
            rx_bytes_per_sec: 50 * 1024 * 1024,
            tx_bytes_per_sec: 50 * 1024 * 1024,
        },
    }
}

fn client(vm: &dyn Sandbox) -> StudyResult<reqwest::Client> {
    let socket = SockPaths::new(RuntimePaths::new().sock_dir(vm.id())).api_sock();
    Ok(reqwest::Client::builder()
        .unix_socket(socket)
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .timeout(DEADLINE)
        .build()?)
}

async fn patch(vm: &dyn Sandbox, path: &Path) -> StudyResult<()> {
    let response = client(vm)?
        .patch("http://localhost/drives/workspace")
        .json(&json!({"drive_id": "workspace", "path_on_host": path}))
        .send()
        .await?;
    if response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err(format!(
            "drive patch {}: {}",
            response.status(),
            response.text().await?
        )
        .into());
    }
    Ok(())
}

async fn verify_runtime(vm: &dyn Sandbox, config: &Config) -> StudyResult<Value> {
    let actual: Value = client(vm)?
        .get("http://localhost/vm/config")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if actual.pointer("/machine-config/vcpu_count") != Some(&json!(config.vcpu))
        || actual.pointer("/machine-config/mem_size_mib") != Some(&json!(config.memory_mb))
    {
        return Err(format!("machine profile mismatch: {actual}").into());
    }
    let drives = actual
        .get("drives")
        .and_then(Value::as_array)
        .ok_or("drive configuration unavailable")?;
    let expected = json!({"bandwidth":{"size": 5 * 1024 * 1024, "refill_time":100, "one_time_burst":null},
        "ops":{"size":500,"refill_time":100,"one_time_burst":null}});
    if drives.len() != 2
        || drives
            .iter()
            .any(|drive| drive.get("rate_limiter") != Some(&expected))
    {
        return Err(format!("block limits changed: {actual}").into());
    }
    let interfaces = actual
        .get("network-interfaces")
        .and_then(Value::as_array)
        .ok_or("network configuration unavailable")?;
    let expected_net = json!({"bandwidth":{"size":5 * 1024 * 1024,"refill_time":100,"one_time_burst":null},"ops":null});
    if interfaces.len() != 1
        || interfaces.iter().any(|interface| {
            interface.get("rx_rate_limiter") != Some(&expected_net)
                || interface.get("tx_rate_limiter") != Some(&expected_net)
        })
    {
        return Err(format!("network limits changed: {actual}").into());
    }
    exec(
        vm,
        &format!(
            "test $(blockdev --getsize64 /dev/vdb) = {}",
            u64::from(config.disk_mb) * 1024 * 1024
        ),
    )
    .await?;
    Ok(actual)
}

fn metrics(pid: Option<u32>) -> Value {
    pid.map_or(Value::Null, |pid| {
        json!({
            "stat": fs::read_to_string(format!("/proc/{pid}/stat")).ok(),
            "status": fs::read_to_string(format!("/proc/{pid}/status")).ok(),
        })
    })
}

struct Trial<'a> {
    root: &'a Path,
    config: &'a Config,
    factory: &'a dyn SandboxFactory,
    base: &'a Path,
    name: String,
    arm: &'a str,
    control: &'a str,
    barrier: Option<&'a tokio::sync::Barrier>,
}

impl Trial<'_> {
    async fn run(&self) -> StudyResult<()> {
        let dir = self.root.join(&self.name);
        fs::create_dir(&dir)?;
        let lease = File::create_new(dir.join("lease"))?;
        lease.try_lock()?;
        let seed = dir.join("seed.ext4");
        let copy = tokio::process::Command::new("cp")
            .args(["--reflink=auto", "--sparse=always", "--"])
            .arg(self.root.join("fixture.ext4"))
            .arg(&seed)
            .status()
            .await?;
        if !copy.success() {
            return Err("fixture copy failed".into());
        }
        if fs::symlink_metadata(&seed)?.len() != u64::from(self.config.disk_mb) * 1024 * 1024 {
            return Err("invalid seed size".into());
        }
        let id = SandboxId::new_v4();
        let mut fields = Map::from_iter([
            ("kind".into(), json!("trial")),
            ("name".into(), json!(self.name)),
            ("arm".into(), json!(self.arm)),
            ("control".into(), json!(self.control)),
            ("id".into(), json!(id.to_string())),
        ]);
        record(json!({"kind":"allocated", "name":self.name, "id":id.to_string()}));
        if self.arm == "fresh"
            && let Some(barrier) = self.barrier
        {
            tokio::time::timeout(DEADLINE, barrier.wait()).await?;
        }
        let start = Instant::now();
        let mut vm = self
            .factory
            .create(SandboxConfig {
                id,
                resources: ResourceLimits {
                    cpu_count: self.config.vcpu,
                    memory_mb: self.config.memory_mb,
                },
                device_rate_limits: Some(limits()),
                workspace_drive: Some(WorkspaceDriveConfig {
                    size_mb: self.config.disk_mb,
                    seed_image: (self.arm == "fresh")
                        .then(|| WorkspaceDriveSeedImage::Move(seed.clone())),
                }),
            })
            .await?;
        fields.insert(
            "create_ms".into(),
            json!(start.elapsed().as_secs_f64() * 1000.0),
        );
        let outcome = match tokio::time::timeout(
            Duration::from_secs(120),
            self.activate(vm.as_mut(), &seed, start, &mut fields),
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(error) => Err(error.into()),
        };
        let pid = vm.host_process_pid();
        fields.insert("metrics_end".into(), metrics(pid));
        fields.insert("ok".into(), json!(outcome.is_ok()));
        fields.insert(
            "error".into(),
            json!(outcome.as_ref().err().map(ToString::to_string)),
        );
        record(Value::Object(fields));
        let stop = vm.stop().await;
        self.factory.destroy(vm).await;
        let socket_gone = !RuntimePaths::new().sock_dir(&id.to_string()).exists();
        let workspace_gone = !self.base.join("workspaces").join(id.to_string()).exists();
        let process_gone = pid.is_none_or(|pid| !Path::new(&format!("/proc/{pid}")).exists());
        record(
            json!({"kind":"cleanup", "name":self.name, "id":id.to_string(),
            "stop":format!("{stop:?}"), "socket_gone":socket_gone,
            "workspace_gone":workspace_gone, "process_gone":process_gone}),
        );
        if stop.is_err() || !socket_gone || !workspace_gone || !process_gone {
            return Err("cleanup invariant failed".into());
        }
        drop(lease);
        fs::remove_file(dir.join("lease"))?;
        if seed.exists() {
            fs::remove_file(seed)?;
        }
        match (self.control, outcome) {
            ("none" | "poison" | "busy", result) => result,
            (_, Err(error)) if error.to_string().starts_with("injected:") => Ok(()),
            (_, Err(error)) => Err(error),
            (_, Ok(())) => Err("expected control failure missing".into()),
        }
    }

    async fn activate(
        &self,
        vm: &mut dyn Sandbox,
        seed: &Path,
        fresh_start: Instant,
        fields: &mut Map<String, Value>,
    ) -> StudyResult<()> {
        let start = Instant::now();
        vm.start().await?;
        fields.insert(
            "start_ms".into(),
            json!(start.elapsed().as_secs_f64() * 1000.0),
        );
        let activation_start = if self.arm == "blank" {
            checked(vm.mount_workspace_drive().await?)?;
            restore(vm).await?;
            if self.control == "poison" {
                exec(vm, "set -eu; printf old-run > /home/user/workspace/old-run; dd if=/dev/zero of=/home/user/workspace/dirty bs=1M count=16 status=none; cat /home/user/workspace/dirty > /dev/null").await?;
            }
            if self.control == "busy" {
                exec(vm, "set -eu; cd /home/user/workspace; if umount /home/user/workspace; then exit 90; fi; test -d /home/user/workspace/lost+found").await?;
            }
            if vm.park_for_blank_pool().await? != SandboxParkOutcome::Reusable {
                return Err("blank park non-reusable".into());
            }
            fields.insert(
                "prewarm_ms".into(),
                json!(fresh_start.elapsed().as_secs_f64() * 1000.0),
            );
            if let Some(barrier) = self.barrier {
                tokio::time::timeout(DEADLINE, barrier.wait()).await?;
            }
            fields.insert("metrics_start".into(), metrics(vm.host_process_pid()));
            let active = Instant::now();
            let stage = Instant::now();
            vm.unpark().await?;
            fields.insert(
                "unpark_ms".into(),
                json!(stage.elapsed().as_secs_f64() * 1000.0),
            );
            if self.control == "cancel-before" {
                return Err("injected: cancel before unmount".into());
            }
            let stage = Instant::now();
            exec(vm, "set -eu; cd /; umount /home/user/workspace; blockdev --flushbufs /dev/vdb; ! mountpoint -q /home/user/workspace").await?;
            fields.insert(
                "unmount_ms".into(),
                json!(stage.elapsed().as_secs_f64() * 1000.0),
            );
            if self.control == "cancel-unmounted" {
                return Err("injected: cancel after unmount".into());
            }
            if self.control == "missing" {
                match patch(vm, &self.root.join("intentionally-missing.ext4")).await {
                    Err(error) if error.to_string().starts_with("drive patch 400") => {
                        return Err(format!("injected: rejected missing image: {error}").into());
                    }
                    Err(error) => return Err(error),
                    Ok(()) => return Err("missing image unexpectedly accepted".into()),
                }
            }
            let stage = Instant::now();
            let work = self.base.join("workspaces").join(vm.id());
            let path = work.join("handoff.ext4");
            if self.control == "invalid" {
                File::create(seed)?.set_len(u64::from(self.config.disk_mb) * 1024 * 1024)?;
            }
            fs::rename(seed, &path)?;
            patch(vm, &path).await?;
            fields.insert(
                "patch_ms".into(),
                json!(stage.elapsed().as_secs_f64() * 1000.0),
            );
            if self.control == "cancel-patched" {
                return Err("injected: cancel after patch".into());
            }
            active
        } else {
            fresh_start
        };
        let stage = Instant::now();
        let mounted = checked(vm.mount_workspace_drive().await?);
        if self.control == "invalid" {
            return match mounted {
                Err(error) => Err(format!("injected: invalid filesystem rejected: {error}").into()),
                Ok(_) => Err("invalid filesystem unexpectedly mounted".into()),
            };
        }
        mounted?;
        fields.insert(
            "mount_ms".into(),
            json!(stage.elapsed().as_secs_f64() * 1000.0),
        );
        if self.control == "cancel-mounted" {
            return Err("injected: cancel after mount".into());
        }
        let stage = Instant::now();
        restore(vm).await?;
        fields.insert(
            "restore_ms".into(),
            json!(stage.elapsed().as_secs_f64() * 1000.0),
        );
        fields.insert(
            "ready_ms".into(),
            json!(activation_start.elapsed().as_secs_f64() * 1000.0),
        );
        let stage = Instant::now();
        let output = exec(vm, include_str!("workspace_handoff_verify.sh")).await?;
        let actual: Value = serde_json::from_slice(&output)?;
        let expected: Value = serde_json::from_slice(&fs::read(self.root.join("expected.json"))?)?;
        if actual != expected {
            fs::write(
                self.root.join(format!("{}.actual.json", self.name)),
                &output,
            )?;
            return Err("workspace content/metadata mismatch".into());
        }
        fields.insert(
            "verify_ms".into(),
            json!(stage.elapsed().as_secs_f64() * 1000.0),
        );
        fields.insert(
            "activation_verified_ms".into(),
            json!(activation_start.elapsed().as_secs_f64() * 1000.0),
        );
        fields.insert(
            "entries".into(),
            json!(
                actual
                    .get("entries")
                    .and_then(Value::as_array)
                    .map(Vec::len)
            ),
        );
        fields.insert(
            "runtime_config".into(),
            verify_runtime(vm, self.config).await?,
        );
        Ok(())
    }
}

async fn run(root: &Path, action: &str, block: &str, rounds: u32) -> StudyResult<()> {
    let root = root.canonicalize()?;
    let config: Config = serde_json::from_slice(&fs::read(root.join("config.json"))?)?;
    if !(1..=4).contains(&config.vcpu)
        || !(512..=4096).contains(&config.memory_mb)
        || !(1024..=10240).contains(&config.disk_mb)
    {
        return Err("study bounds: 1..4 vCPU, 512..4096 MiB memory, 1024..10240 MiB disk".into());
    }
    let lock = File::options()
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("study.lock"))?;
    lock.try_lock()?;
    let snapshot_id = fs::read_to_string(root.join("snapshot-id"))?
        .trim()
        .to_owned();
    if action == "snapshot" {
        if root.join("snapshot").exists() {
            return Err("snapshot already exists".into());
        }
        create_snapshot(SnapshotCreateConfig {
            id: snapshot_id,
            binary_path: config.binary,
            kernel_path: config.kernel,
            rootfs_path: config.rootfs,
            output_dir: root.join("snapshot"),
            vcpu_count: config.vcpu,
            memory_mb: config.memory_mb,
            workspace_disk_mb: config.disk_mb,
        })
        .await?;
        record(json!({"kind":"snapshot_complete"}));
        return Ok(());
    }
    if !matches!(action, "paired" | "concurrent" | "controls") || rounds > 32 || rounds == 0 {
        return Err("expected snapshot, paired, concurrent or controls; 1..32 rounds".into());
    }
    let base = root.join(format!("runtime-{action}-{block}"));
    fs::create_dir(&base)?;
    let mut runtime = FirecrackerRuntime::new(RuntimeConfig {
        proxy_port: None,
        dns_port: None,
        host_cpu_placement: None,
    })
    .await?;
    let result = async {
        let mut factory = runtime
            .create_factory(FactoryConfig {
                profile: "workspace-handoff-study".into(),
                binary_path: config.binary.clone(),
                kernel_path: config.kernel.clone(),
                rootfs_path: config.rootfs.clone(),
                base_dir: base.clone(),
                snapshot: Some(SnapshotRef {
                    hash: snapshot_id,
                    output_dir: root.join("snapshot"),
                }),
            })
            .await?;
        let result = async {
            if action == "controls" {
                for control in [
                    "poison",
                    "busy",
                    "missing",
                    "invalid",
                    "cancel-before",
                    "cancel-unmounted",
                    "cancel-patched",
                    "cancel-mounted",
                ] {
                    Trial {
                        root: &root,
                        config: &config,
                        factory: factory.as_ref(),
                        base: &base,
                        name: format!("{action}-{block}-{control}"),
                        arm: "blank",
                        control,
                        barrier: None,
                    }
                    .run()
                    .await?;
                }
            } else {
                for round in 0..rounds {
                    let arms = if round % 2 == 0 {
                        ["fresh", "blank"]
                    } else {
                        ["blank", "fresh"]
                    };
                    for arm in arms {
                        let barrier = tokio::sync::Barrier::new(2);
                        let first = Trial {
                            root: &root,
                            config: &config,
                            factory: factory.as_ref(),
                            base: &base,
                            name: format!("{action}-{block}-{round}-{arm}-0"),
                            arm,
                            control: "none",
                            barrier: (action == "concurrent").then_some(&barrier),
                        };
                        if action == "concurrent" {
                            let second = Trial {
                                name: format!("{action}-{block}-{round}-{arm}-1"),
                                ..first
                            };
                            let (a, b) = tokio::join!(first.run(), second.run());
                            a?;
                            b?;
                        } else {
                            first.run().await?;
                        }
                    }
                }
            }
            Ok::<(), Box<dyn Error + Send + Sync>>(())
        }
        .await;
        factory.shutdown().await;
        result
    }
    .await;
    runtime.shutdown().await;
    result
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> StudyResult<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<String> = std::env::args().collect();
    let [_, root, action, block, rounds]: [String; 5] = args
        .try_into()
        .map_err(|_| "usage: workspace_handoff STUDY_ROOT ACTION BLOCK ROUNDS")?;
    if block.is_empty()
        || !block
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("usage: workspace_handoff STUDY_ROOT ACTION BLOCK ROUNDS".into());
    }
    let result = run(Path::new(&root), &action, &block, rounds.parse()?).await;
    record(
        json!({"kind":"complete", "ok":result.is_ok(), "error":result.as_ref().err().map(ToString::to_string)}),
    );
    std::io::stdout().flush()?;
    result
}
