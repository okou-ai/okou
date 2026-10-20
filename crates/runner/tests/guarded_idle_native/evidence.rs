//! Native receipts complement, rather than replace, the owned-command collector.

use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
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
    pub snapshot_preparation_sha256: String,
    pub policy_sha256: String,
}

impl Artifacts {
    pub fn load_and_verify() -> TestResult<Self> {
        let path = std::env::var("OKOU_TEST_TERMINAL_ARTIFACTS")?;
        let value: Self = serde_json::from_slice(&std::fs::read(path)?)?;
        let compiled = compiled_source()?;
        if value.source_sha != compiled {
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
        super::snapshot_preparation::verify_record(Path::new(&snapshot), &value)?;
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
            "snapshot_preparation_sha256": self.snapshot_preparation_sha256,
            "policy_sha256": self.policy_sha256,
            "profile": {"vcpu": 2, "memory_mib": 4096, "home_mib": 16384},
            "required_fixture_tail_bytes": TAIL_BYTES,
        })
    }
}

pub(super) fn compiled_source() -> TestResult<&'static str> {
    let source = option_env!("OKOU_TEST_BUILD_SOURCE_SHA")
        .ok_or_else(|| io::Error::other("native source SHA was not supplied at compilation"))?;
    if source.len() != 40
        || !source
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err(io::Error::other("invalid native compiled source SHA").into());
    }
    Ok(source)
}

pub fn verify_file(path: &Path, expected: &str) -> TestResult<()> {
    if expected.len() != 64 || !expected.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(io::Error::other("invalid artifact SHA-256").into());
    }
    if file_sha256(path)? != expected {
        return Err(io::Error::other(format!(
            "native artifact identity mismatch: {}",
            path.display()
        ))
        .into());
    }
    Ok(())
}

pub(super) fn file_sha256(path: &Path) -> TestResult<String> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let before = file.metadata()?;
    if !before.file_type().is_file() {
        return Err(io::Error::other("native artifact is not a regular file").into());
    }
    let limit = before
        .len()
        .checked_add(1)
        .ok_or_else(|| io::Error::other("native artifact length overflow"))?;
    let mut reader = (&mut file).take(limit);
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    let mut total = 0_u64;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        hash.update(
            buffer
                .get(..count)
                .ok_or_else(|| io::Error::other("invalid native read count"))?,
        );
    }
    let after = file.metadata()?;
    if total != before.len()
        || before.len() != after.len()
        || (
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec(),
        ) != (
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec(),
        )
    {
        return Err(io::Error::other("native artifact changed while hashing").into());
    }
    Ok(hex::encode(hash.finalize()))
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
    foreground_io: Mutex<Option<Arc<super::foreground_io::Gate>>>,
    incoming_creations: std::sync::atomic::AtomicBool,
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
            foreground_io: Mutex::new(None),
            incoming_creations: std::sync::atomic::AtomicBool::new(false),
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

    pub fn critical_progress_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_CRITICAL_PROGRESS_WITNESS ", phase, evidence)
    }

    pub fn read_cancellation_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_READ_CANCELLATION_WITNESS ", phase, evidence)
    }

    pub fn read_revocation_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_READ_REVOCATION_WITNESS ", phase, evidence)
    }

    pub fn read_stop_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_READ_STOP_WITNESS ", phase, evidence)
    }

    pub fn observer_loss_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_OBSERVER_LOSS_WITNESS ", phase, evidence)
    }

    pub fn status_failure_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_STATUS_FAILURE_WITNESS ", phase, evidence)
    }

    pub fn later_parking_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_LATER_PARKING_WITNESS ", phase, evidence)
    }

    pub fn batch_aba_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_BATCH_ABA_WITNESS ", phase, evidence)
    }

    pub fn batch_repark_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_BATCH_REPARK_WITNESS ", phase, evidence)
    }

    pub fn batch_replacement_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_BATCH_REPLACEMENT_WITNESS ", phase, evidence)
    }

    pub fn dual_history_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_DUAL_HISTORY_WITNESS ", phase, evidence)
    }

    pub fn claim_loss_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_CLAIM_LOSS_WITNESS ", phase, evidence)
    }

    pub fn speculative_fault_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_SPECULATIVE_FAULT_WITNESS ", phase, evidence)
    }

    pub fn claim_producer_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_CLAIM_PRODUCER_WITNESS ", phase, evidence)
    }

    pub fn real_claim_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_REAL_API_CLAIM_WITNESS ", phase, evidence)
    }

    pub fn unpark_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_UNPARK_WITNESS ", phase, evidence)
    }

    pub fn pause_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_PAUSE_WITNESS ", phase, evidence)
    }

    pub fn require_original_lease_released(&self) -> io::Result<()> {
        let state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("native receipt state poisoned"))?;
        if !state
            .original_lease
            .as_ref()
            .is_some_and(|lease| !lease.is_active())
        {
            return Err(io::Error::other("native original full lease remains owned"));
        }
        Ok(())
    }

    pub fn shared_reads_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_SHARED_READS_WITNESS ", phase, evidence)
    }

    pub fn create_cancellation_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_CREATE_CANCELLATION_WITNESS ", phase, evidence)
    }

    pub fn returned_guest_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_RETURNED_GUEST_WITNESS ", phase, evidence)
    }

    pub fn startup_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_STARTUP_WITNESS ", phase, evidence)
    }

    pub fn foreground_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_FOREGROUND_WITNESS ", phase, evidence)
    }

    pub fn install_foreground_io(&self, gate: Arc<super::foreground_io::Gate>) -> io::Result<()> {
        let mut current = self
            .foreground_io
            .lock()
            .map_err(|_| io::Error::other("native IO owner poisoned"))?;
        if current.is_some() {
            return Err(io::Error::other("native IO owner already installed"));
        }
        *current = Some(gate);
        Ok(())
    }

    pub fn foreground_io(&self) -> io::Result<Option<Arc<super::foreground_io::Gate>>> {
        Ok(self
            .foreground_io
            .lock()
            .map_err(|_| io::Error::other("native IO owner poisoned"))?
            .clone())
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

    pub fn fence_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_FENCE_WITNESS ", phase, evidence)
    }

    pub fn logical_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_LOGICAL_PROGRESS_WITNESS ", phase, evidence)
    }

    pub fn incoming_witness(&self, phase: &str, evidence: Value) -> io::Result<()> {
        self.write_event("NATIVE_INCOMING_PROGRESS_WITNESS ", phase, evidence)
    }

    pub fn observe_incoming_creations(&self, enabled: bool) {
        self.incoming_creations
            .store(enabled, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn incoming_creation(&self, id: sandbox::SandboxId) -> io::Result<()> {
        if self
            .incoming_creations
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            self.incoming_witness(
                "guest_creation_started",
                json!({"sandbox_id": id.to_string()}),
            )?;
        }
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
