//! Native receipts complement, rather than replace, the owned-command collector.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use sandbox::SandboxBackingProcess;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{TestResult, io};

pub const PREFIX: &str = "NATIVE_TERMINAL_RECEIPT ";
const PRESSURE_PREFIX: &str = "NATIVE_PRESSURE_WITNESS ";
const CONTINUATION_PREFIX: &str = "NATIVE_CONTINUATION_WITNESS ";
const OPTIONAL_PREFIX: &str = "NATIVE_OPTIONAL_WITNESS ";
pub const TAIL_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artifacts {
    pub source_sha: String,
    pub test_binary_sha256: String,
    pub firecracker_sha256: String,
    pub kernel_sha256: String,
    pub rootfs_sha256: String,
    pub snapshot_id: String,
    pub snapshot_files: std::collections::BTreeMap<String, String>,
    pub policy_sha256: String,
}

impl Artifacts {
    pub fn load_and_verify() -> TestResult<Self> {
        let path = std::env::var("OKOU_TEST_TERMINAL_ARTIFACTS")?;
        let value: Self = serde_json::from_slice(&std::fs::read(path)?)?;
        let compiled = option_env!("OKOU_TEST_BUILD_SOURCE_SHA")
            .ok_or_else(|| io::Error::other("native source SHA was not supplied at compilation"))?;
        if value.source_sha != compiled
            || value.source_sha.len() != 40
            || !value.source_sha.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(io::Error::other("native compiled-source identity mismatch").into());
        }
        verify_file(&std::env::current_exe()?, &value.test_binary_sha256)?;
        for (name, expected) in [
            ("OKOU_TEST_RPC_FIRECRACKER", &value.firecracker_sha256),
            ("OKOU_TEST_RPC_KERNEL", &value.kernel_sha256),
            ("OKOU_TEST_RPC_ROOTFS", &value.rootfs_sha256),
            ("OKOU_TEST_IDLE_MEMORY_POLICY", &value.policy_sha256),
        ] {
            verify_file(Path::new(&std::env::var(name)?), expected)?;
        }
        let snapshot = std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?;
        if std::env::var("OKOU_TEST_RPC_SNAPSHOT_HASH")? != value.snapshot_id {
            return Err(io::Error::other("native snapshot creation identity mismatch").into());
        }
        let output = sandbox_firecracker::SnapshotOutputPaths::new(snapshot.clone().into());
        for path in output
            .required_artifacts()
            .into_iter()
            .chain([output.complete_marker()])
        {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| io::Error::other("snapshot artifact filename is not UTF-8"))?;
            if !value.snapshot_files.contains_key(name) {
                return Err(
                    io::Error::other("complete snapshot artifact hashes are required").into(),
                );
            }
        }
        for (name, expected) in &value.snapshot_files {
            if name.is_empty()
                || Path::new(name).components().count() != 1
                || !matches!(
                    Path::new(name).components().next(),
                    Some(std::path::Component::Normal(_))
                )
            {
                return Err(io::Error::other("invalid snapshot artifact filename").into());
            }
            verify_file(&Path::new(&snapshot).join(name), expected)?;
        }
        Ok(value)
    }

    fn receipt(&self) -> Value {
        json!({
            "source_sha": self.source_sha,
            "test_binary_sha256": self.test_binary_sha256,
            "firecracker_sha256": self.firecracker_sha256,
            "kernel_sha256": self.kernel_sha256,
            "rootfs_sha256": self.rootfs_sha256,
            "snapshot_id": self.snapshot_id,
            "snapshot_files": self.snapshot_files,
            "policy_sha256": self.policy_sha256,
            "profile": {"vcpu": 2, "memory_mib": 4096, "home_mib": 16384},
            "required_fixture_tail_bytes": TAIL_BYTES,
        })
    }
}

pub fn verify_file(path: &Path, expected: &str) -> TestResult<()> {
    if expected.len() != 64 || !expected.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(io::Error::other("invalid artifact SHA-256").into());
    }
    if !std::fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(io::Error::other("native artifact is not a regular file").into());
    }
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(
            buffer
                .get(..count)
                .ok_or_else(|| io::Error::other("invalid native read count"))?,
        );
    }
    if hex::encode(hash.finalize()) != expected {
        return Err(io::Error::other(format!(
            "native artifact identity mismatch: {}",
            path.display()
        ))
        .into());
    }
    Ok(())
}

/// CLOCK_MONOTONIC matches P1's monotonic_ns; wall time is supplementary.
pub(super) fn clocks() -> io::Result<(u64, u128)> {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: time is an initialized, aligned timespec valid for the whole call.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let seconds = u64::try_from(time.tv_sec).map_err(io::Error::other)?;
    let nanos = u64::try_from(time.tv_nsec).map_err(io::Error::other)?;
    let monotonic = seconds
        .checked_mul(1_000_000_000)
        .and_then(|v| v.checked_add(nanos))
        .ok_or_else(|| io::Error::other("native clock overflow"))?;
    let wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    Ok((monotonic, wall))
}

struct State {
    sandbox_id: Option<String>,
    backing_generation: Option<String>,
    tail_completed: bool,
    budget: Option<Arc<runner_lifecycle::resource_budget::ResourceBudget>>,
    original_lease: Option<runner_lifecycle::resource_budget::BudgetLeaseWitness>,
}

pub struct Case {
    id: String,
    artifacts: Artifacts,
    state: Mutex<State>,
    exit_observer: Mutex<Option<tokio::task::JoinHandle<io::Result<()>>>>,
    retained: Mutex<Vec<Box<dyn Send>>>,
}

impl Case {
    pub fn new(id: String, artifacts: Artifacts) -> TestResult<Arc<Self>> {
        let case = Arc::new(Self {
            id,
            artifacts,
            state: Mutex::new(State {
                sandbox_id: None,
                backing_generation: None,
                tail_completed: false,
                budget: None,
                original_lease: None,
            }),
            exit_observer: Mutex::new(None),
            retained: Mutex::new(Vec::new()),
        });
        case.event(
            "case_started",
            json!({"artifacts": case.artifacts.receipt()}),
        )?;
        Ok(case)
    }

    pub fn event(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event(PREFIX, phase, evidence)
    }

    pub fn pressure_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event(PRESSURE_PREFIX, phase, evidence)
    }

    pub fn continuation_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event(CONTINUATION_PREFIX, phase, evidence)
    }

    pub fn optional_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event(OPTIONAL_PREFIX, phase, evidence)
    }

    pub fn recovery_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_RECOVERY_WITNESS ", phase, evidence)
    }

    pub fn critical_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_CRITICAL_WITNESS ", phase, evidence)
    }

    pub fn startup_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_STARTUP_WITNESS ", phase, evidence)
    }

    pub fn snapshot_memory_hash(&self) -> io::Result<&str> {
        self.artifacts
            .snapshot_files
            .get("memory.bin")
            .map(String::as_str)
            .ok_or_else(|| io::Error::other("native optional snapshot memory identity missing"))
    }

    pub fn bind_original_lease(
        &self,
        lease: &runner_lifecycle::resource_budget::BudgetLease,
    ) -> io::Result<()> {
        let witness = lease
            .witness()
            .ok_or_else(|| io::Error::other("native original reservation is detached"))?;
        if witness.resources() != (2, 4096) || !witness.is_active() {
            return Err(io::Error::other(
                "native original lease has the wrong shape",
            ));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("native receipt state poisoned"))?;
        if state.original_lease.is_some() {
            return Err(io::Error::other("native original lease was bound twice"));
        }
        state.original_lease = Some(witness);
        Ok(())
    }

    fn write_event(&self, prefix: &str, phase: &str, evidence: Value) -> io::Result<()> {
        let (monotonic_ns, unix_ns) = clocks()?;
        let state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("native receipt state poisoned"))?;
        println!(
            "\n{prefix}{}",
            json!({
                "version": 1, "case": self.id, "phase": phase,
                "monotonic_ns": monotonic_ns, "unix_ns": unix_ns,
                "sandbox_id": state.sandbox_id,
                "backing_generation": state.backing_generation,
                "evidence": evidence,
            })
        );
        Ok(())
    }

    pub fn bind(
        self: &Arc<Self>,
        id: String,
        backing: Arc<dyn SandboxBackingProcess>,
        budget: Arc<runner_lifecycle::resource_budget::ResourceBudget>,
    ) -> io::Result<()> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| io::Error::other("native receipt state poisoned"))?;
            if state.sandbox_id.is_some() {
                return Err(io::Error::other("native backing was bound twice"));
            }
            state.sandbox_id = Some(id);
            state.backing_generation = Some(backing.identity().generation().to_string());
            state.budget = Some(budget);
        }
        let case = self.clone();
        let original = backing.identity();
        let observer = tokio::spawn(async move {
            if !backing.exit_confirmed().await || backing.identity() != original {
                return Err(io::Error::other("native original backing exit unconfirmed"));
            }
            case.event(
                "backing_exit_confirmed",
                json!({"positive_owned_wait": true}),
            )
        });
        *self
            .exit_observer
            .lock()
            .map_err(|_| io::Error::other("native observer state poisoned"))? = Some(observer);
        Ok(())
    }

    pub fn owns(&self, id: &str) -> bool {
        self.state
            .lock()
            .is_ok_and(|s| s.sandbox_id.as_deref() == Some(id))
    }

    /// Failed native runs keep real owners alive until their bounded driver ends.
    /// A retained factory also owns this case, so uncertainty cannot trigger Drop
    /// cleanup of required home state. P1 intervention is always a failed result.
    pub fn retain(&self, owner: impl Send + 'static) {
        self.retained
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Box::new(owner));
    }

    pub fn release_completed_owners(&self) {
        self.retained
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    pub fn require_full_lease(&self) -> io::Result<()> {
        let state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("native receipt state poisoned"))?;
        let held = if let Some(original) = &state.original_lease {
            original.is_active() && original.resources() == (2, 4096)
        } else {
            state.budget.as_ref().map(|b| b.allocated()) == Some((2, 4096, 1))
        };
        if !held {
            return Err(io::Error::other(
                "native tail lost its original full logical lease",
            ));
        }
        Ok(())
    }

    pub async fn join_exit(&self) -> io::Result<()> {
        let observer = self
            .exit_observer
            .lock()
            .map_err(|_| io::Error::other("native observer state poisoned"))?
            .take();
        if let Some(observer) = observer {
            observer.await.map_err(io::Error::other)??;
        }
        Ok(())
    }

    pub fn complete_tail(&self) -> io::Result<()> {
        self.state
            .lock()
            .map_err(|_| io::Error::other("native receipt state poisoned"))?
            .tail_completed = true;
        self.event(
            "required_tail_completed",
            json!({"written_and_verified_bytes": TAIL_BYTES}),
        )
    }

    pub async fn finish(&self) -> TestResult<()> {
        self.join_exit().await?;
        let state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("native receipt state poisoned"))?;
        if !state.tail_completed
            || state.budget.as_ref().map(|b| b.allocated()) != Some((0, 0, 0))
            || state
                .original_lease
                .as_ref()
                .is_some_and(|lease| lease.is_active())
        {
            return Err(io::Error::other("native required physical tail was not completed").into());
        }
        drop(state);
        self.event(
            "case_completed",
            json!({
                "original_home_restored": true, "private_runtime_removed": true,
                "required_cleanup_joined": true, "full_lease_released_after_cleanup": true,
                "home_payload_bytes": super::fixture::PAYLOAD_BYTES,
            }),
        )?;
        Ok(())
    }
}
