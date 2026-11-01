//! Root-owned, operation-scoped kernel reader reused by metrics and cleanup.

use guest_contracts::oom_evidence::*;
use guest_contracts::process_containment::CGROUP_V2_MOUNT_PATH;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const FILE_BYTES: usize = 4096;
const KERNEL_RECORDS: usize = 128;
const CAPTURE_BUDGET: Duration = Duration::from_millis(50);

pub(crate) struct EvidenceMonitor {
    root: PathBuf,
    cgroup_root: String,
    initial: [MemorySnapshot; 3],
    evidence: OomEvidence,
    kernel: Option<File>,
    kernel_status: EvidenceStatus,
    last_sequence: Option<u64>,
    previous_events: MemoryEvents,
    // Kernel decisions can precede the corresponding workload kill counter.
    // Credits belong only to the latest incident and never exceed four.
    pending_kernel_kills: u64,
}

impl EvidenceMonitor {
    #[cfg(test)]
    pub(crate) fn without_kernel_for_test(root: PathBuf) -> Self {
        // Only the read location is synthetic. Identity still traverses the
        // production mount-relative conversion, never the temporary directory.
        Self::with_sources(
            Path::new("/sys/fs/cgroup/vm0-exec/exec-281-10-3"),
            root,
            Err(io::Error::from(io::ErrorKind::NotFound)),
            boottime_us(),
        )
        .unwrap()
    }

    pub(crate) fn new(root: PathBuf) -> Option<Self> {
        let started = boottime_us();
        let kernel_result = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open("/dev/kmsg")
            .and_then(|mut file| {
                file.seek(SeekFrom::End(0))?;
                Ok(file)
            });
        Self::with_sources(&root, root.clone(), kernel_result, started)
    }

    fn with_sources(
        identity_root: &Path,
        root: PathBuf,
        kernel_result: io::Result<File>,
        started: u64,
    ) -> Option<Self> {
        let cgroup_root = operation_cgroup(identity_root)?;
        let kernel_status = match &kernel_result {
            Ok(_) => EvidenceStatus::Available,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => EvidenceStatus::Denied,
            Err(_) => EvidenceStatus::Unavailable,
        };
        let initial = snapshots(&root, &cgroup_root, None, Instant::now() + CAPTURE_BUDGET);
        let guest_boot_id = bounded_read(Path::new("/proc/sys/kernel/random/boot_id"))
            .ok()
            .and_then(|text| uuid::Uuid::parse_str(text.trim()).ok())
            .map(|id| id.to_string());
        let evidence = OomEvidence {
            operation_id: uuid::Uuid::new_v4().to_string(),
            guest_boot_id,
            started_boottime_us: started,
            sampled_at: timestamp(),
            kernel_cursor: None,
            kernel_status,
            groups: initial.clone(),
            incidents: Vec::new(),
            dropped_incidents: 0,
        };
        Some(Self {
            root,
            cgroup_root,
            previous_events: initial[0].events.clone(),
            pending_kernel_kills: 0,
            initial,
            evidence,
            kernel: kernel_result.ok(),
            kernel_status,
            last_sequence: None,
        })
    }

    pub(crate) fn capture(&mut self, reason: CaptureReason) -> OomEvidence {
        let deadline = Instant::now() + CAPTURE_BUDGET;
        let (mut kernel_events, mut kernel_status) = self.read_kernel(deadline);
        let groups = snapshots(&self.root, &self.cgroup_root, Some(&self.initial), deadline);
        if groups
            .iter()
            .any(|group| group.status == EvidenceStatus::Recreated)
        {
            kernel_events.clear();
            kernel_status = EvidenceStatus::Recreated;
        }
        let counters = groups[0].events.delta(&self.previous_events);
        let new_oom = groups[0].status != EvidenceStatus::Recreated && counters.has_oom();
        retain_observed_counters(&mut self.previous_events, &groups[0].events);
        if !matches!(
            kernel_status,
            EvidenceStatus::Available | EvidenceStatus::Missing
        ) {
            self.pending_kernel_kills = 0;
        }
        // A fully drained reader with no new OOM decision can reconcile only
        // the kill-counter tail of a previously captured workload victim.
        // Keep its original capture time/snapshot; current groups below carry
        // the later observed counters. Any fresh attempt or source gap prevents
        // correlation, so stale credits cannot hide an independent incident.
        let deferred_kernel_counter = kernel_events.is_empty()
            && counters.oom == Some(0)
            && counters.oom_group_kill == Some(0)
            && counters
                .oom_kill
                .is_some_and(|count| count > 0 && count <= self.pending_kernel_kills);
        if deferred_kernel_counter {
            self.pending_kernel_kills -= counters.oom_kill.unwrap_or_default();
        }
        let incoming_kernel_kills = kernel_events
            .iter()
            .filter(|event| {
                event.task_cgroup == groups[0].cgroup
                    || event
                        .task_cgroup
                        .starts_with(&format!("{}/", groups[0].cgroup))
            })
            .count() as u64;
        self.evidence.sampled_at = timestamp();
        self.evidence.kernel_cursor = self.last_sequence;
        self.evidence.kernel_status = kernel_status;
        self.evidence.groups = groups.clone();
        let has_kernel = !kernel_events.is_empty();
        let candidate = reason == CaptureReason::CliError;

        // A late kernel record enriches the same counter transition. The cursor
        // prevents a second report of the same record on exit/cleanup.
        if has_kernel
            && !new_oom
            && let Some(last) = self.evidence.incidents.last_mut()
            && last.kernel_events.is_empty()
            && last.groups[0].events == groups[0].events
        {
            last.kernel_events = kernel_events;
            last.kernel_status = kernel_status;
            // The counter-first incident already accounted for these kills.
            self.pending_kernel_kills = 0;
            self.persist_latest();
        } else if (new_oom && !deferred_kernel_counter)
            || has_kernel
            || (candidate && self.evidence.incidents.is_empty())
        {
            self.pending_kernel_kills = if matches!(
                kernel_status,
                EvidenceStatus::Available | EvidenceStatus::Missing
            ) {
                counters
                    .oom_kill
                    .map_or(0, |observed| incoming_kernel_kills.saturating_sub(observed))
            } else {
                0
            };
            if self.evidence.incidents.len() < MAX_INCIDENTS {
                self.evidence.incidents.push(OomIncident {
                    id: format!(
                        "{}:{}",
                        self.evidence.operation_id,
                        self.evidence.incidents.len() + 1
                    ),
                    captured_at: self.evidence.sampled_at.clone(),
                    reason,
                    after_observation: true,
                    before_cleanup: true,
                    kernel_status,
                    kernel_events,
                    groups,
                });
                self.persist_latest();
            } else {
                self.evidence.dropped_incidents = self.evidence.dropped_incidents.saturating_add(1);
            }
        }
        self.evidence.clone()
    }

    fn persist_latest(&self) {
        // This root-owned log is already streamed to Runner and retained there.
        // Emit before cleanup; Guest Agent separately persists its urgent payload.
        if let Some(incident) = self.evidence.incidents.last()
            && let Ok(json) = serde_json::to_string(incident)
            && json.len() <= MAX_EVIDENCE_BYTES
        {
            crate::log::log("INFO", &format!("guest oom incident {json}"));
        }
    }

    fn read_kernel(&mut self, deadline: Instant) -> (Vec<KernelOomEvent>, EvidenceStatus) {
        let Some(kernel) = self.kernel.as_mut() else {
            return (Vec::new(), self.kernel_status);
        };
        read_kernel_records(
            kernel,
            &mut self.kernel_status,
            &mut self.last_sequence,
            self.evidence.started_boottime_us,
            &self.initial[0].cgroup,
            deadline,
        )
    }
}

fn operation_cgroup(root: &Path) -> Option<String> {
    let relative = root.strip_prefix(CGROUP_V2_MOUNT_PATH).ok()?.to_str()?;
    let operation = relative.strip_prefix("vm0-exec/exec-")?;
    // Require the exact trusted mount and one operation component. Do not
    // reinterpret another mount, a traversal or an arbitrary path as evidence.
    if relative.len() + "/workload/runtime".len() + 1 > 256
        || root.to_str()? != format!("{CGROUP_V2_MOUNT_PATH}/{relative}")
        || operation.is_empty()
        || !operation
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
    {
        return None;
    }
    Some(format!("/{relative}"))
}

fn retain_observed_counters(previous: &mut MemoryEvents, current: &MemoryEvents) {
    previous.high = current.high.or(previous.high);
    previous.max = current.max.or(previous.max);
    previous.oom = current.oom.or(previous.oom);
    previous.oom_kill = current.oom_kill.or(previous.oom_kill);
    previous.oom_group_kill = current.oom_group_kill.or(previous.oom_group_kill);
}

fn read_kernel_records(
    kernel: &mut (impl Read + Seek),
    source_status: &mut EvidenceStatus,
    last_sequence: &mut Option<u64>,
    started_boottime_us: u64,
    workload: &str,
    deadline: Instant,
) -> (Vec<KernelOomEvent>, EvidenceStatus) {
    let mut events = Vec::new();
    let mut status = *source_status;
    let mut buffer = [0; FILE_BYTES];
    for _ in 0..KERNEL_RECORDS {
        if Instant::now() >= deadline {
            return (events, EvidenceStatus::Truncated);
        }
        match kernel.read(&mut buffer) {
            Ok(0) => return finish_kernel_read(events, status),
            Ok(count) => {
                let Some(bytes) = buffer.get(..count) else {
                    return (events, EvidenceStatus::Partial);
                };
                let Ok(record) = std::str::from_utf8(bytes) else {
                    status = EvidenceStatus::Partial;
                    continue;
                };
                let Some((sequence, time, message)) = kernel_record(record) else {
                    continue;
                };
                if last_sequence.is_some_and(|previous| sequence <= previous)
                    || time < started_boottime_us
                {
                    continue;
                }
                *last_sequence = Some(sequence);
                if !message.starts_with("oom-kill:") {
                    continue;
                }
                match parse_oom(message, sequence, time, workload) {
                    Some(event) if events.len() < MAX_KERNEL_EVENTS => events.push(event),
                    Some(_) => status = EvidenceStatus::Truncated,
                    None => status = EvidenceStatus::Uncorrelated,
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                return finish_kernel_read(events, status);
            }
            Err(error) if error.raw_os_error() == Some(libc::EPIPE) => {
                status = EvidenceStatus::Overwritten;
                *source_status = status;
            }
            Err(error) if error.raw_os_error() == Some(libc::EINVAL) => {
                // An oversized record cannot be consumed with this buffer.
                // Skip to the end instead of retrying the same record forever.
                let _ = kernel.seek(SeekFrom::End(0));
                *source_status = EvidenceStatus::Truncated;
                return (events, EvidenceStatus::Truncated);
            }
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return (events, EvidenceStatus::Denied);
            }
            Err(_) => return (events, EvidenceStatus::Unavailable),
        }
    }
    (events, EvidenceStatus::Truncated)
}

fn finish_kernel_read(
    events: Vec<KernelOomEvent>,
    status: EvidenceStatus,
) -> (Vec<KernelOomEvent>, EvidenceStatus) {
    let status = if events.is_empty() && status == EvidenceStatus::Available {
        EvidenceStatus::Missing
    } else {
        status
    };
    (events, status)
}

fn kernel_record(record: &str) -> Option<(u64, u64, &str)> {
    let (header, message) = record.split_once(';')?;
    let mut fields = header.split(',');
    // /dev/kmsg can contain userspace writes. Only kernel facility is evidence.
    if fields.next()?.parse::<u32>().ok()? >> 3 != 0 {
        return None;
    }
    Some((
        fields.next()?.parse().ok()?,
        fields.next()?.parse().ok()?,
        message.trim_end(),
    ))
}

fn parse_oom(message: &str, sequence: u64, time: u64, workload: &str) -> Option<KernelOomEvent> {
    let rest = message.strip_prefix("oom-kill:")?;
    let field = |name: &str| {
        let mut matches = rest.split(',').filter_map(|part| part.strip_prefix(name));
        let value = matches.next()?;
        matches.next().is_none().then_some(value)
    };
    let constraint = field("constraint=")?;
    if ![
        "CONSTRAINT_NONE",
        "CONSTRAINT_MEMCG",
        "CONSTRAINT_CPUSET",
        "CONSTRAINT_MEMORY_POLICY",
    ]
    .contains(&constraint)
    {
        return None;
    }
    let task_cgroup = field("task_memcg=")?;
    if !owned_task_cgroup(task_cgroup, workload) {
        return None;
    }
    let victim_comm = field("task=")?;
    if victim_comm.is_empty() || victim_comm.len() > 16 || victim_comm.chars().any(char::is_control)
    {
        return None;
    }
    let victim_pid = field("pid=")?.parse::<u32>().ok().filter(|pid| *pid > 0)?;
    let oom_cgroup = field("oom_memcg=")
        .filter(|path| {
            owned_task_cgroup(path, workload)
                || *path == "/"
                || workload
                    .strip_prefix(*path)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
        .map(str::to_owned);
    Some(KernelOomEvent {
        source: "guest".into(),
        sequence,
        boottime_us: time,
        constraint: constraint.into(),
        oom_cgroup,
        victim_pid,
        victim_comm: victim_comm.into(),
        task_cgroup: task_cgroup.into(),
    })
}

fn owned_task_cgroup(path: &str, workload: &str) -> bool {
    if workload
        .strip_suffix("/workload")
        .is_some_and(|operation| path == format!("{operation}/control"))
        || path == workload
        || path == format!("{workload}/runtime")
        || path == format!("{workload}/tools")
    {
        return true;
    }
    if guest_contracts::managed_task::owned_task_path(path, workload) {
        return true;
    }
    path.strip_prefix(&format!("{workload}/tools/tool-"))
        .is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix.len() <= 64
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'-')
        })
}

fn bounded_read(path: &Path) -> io::Result<String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)?;
    let mut bytes = Vec::new();
    file.take((FILE_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > FILE_BYTES {
        return Err(io::Error::other("evidence source exceeds byte limit"));
    }
    String::from_utf8(bytes).map_err(|_| io::Error::other("invalid source encoding"))
}

fn values(text: Option<&str>, key: &str) -> Option<u64> {
    text?.lines().find_map(|line| {
        let mut fields = line.split_ascii_whitespace();
        if fields.next()? != key {
            return None;
        }
        let value = fields.next()?.parse().ok()?;
        fields.next().is_none().then_some(value)
    })
}

fn events(text: Option<&str>) -> MemoryEvents {
    MemoryEvents {
        high: values(text, "high"),
        max: values(text, "max"),
        oom: values(text, "oom"),
        oom_kill: values(text, "oom_kill"),
        oom_group_kill: values(text, "oom_group_kill"),
    }
}

fn snapshots(
    root: &Path,
    cgroup_root: &str,
    baseline: Option<&[MemorySnapshot; 3]>,
    deadline: Instant,
) -> [MemorySnapshot; 3] {
    ["workload", "runtime", "tools"].map(|role| {
        let index = match role {
            "workload" => 0,
            "runtime" => 1,
            _ => 2,
        };
        let path = if index == 0 {
            root.join("workload")
        } else {
            root.join("workload").join(role)
        };
        let initial = baseline.and_then(|items| items.get(index));
        let inode = fs::metadata(&path).ok().map(|metadata| metadata.ino());
        let recreated = initial.is_some_and(|value| value.inode != inode);
        let mut truncated = false;
        let mut read = |name: &str| {
            if recreated {
                return None;
            }
            if Instant::now() >= deadline {
                truncated = true;
                return None;
            }
            match bounded_read(&path.join(name)) {
                Ok(value) => Some(value),
                Err(error) => {
                    if error.kind() == io::ErrorKind::Other {
                        truncated = true;
                    }
                    None
                }
            }
        };
        let current = read("memory.current").and_then(|value| value.trim().parse().ok());
        let peak = read("memory.peak").and_then(|value| value.trim().parse().ok());
        let limit = read("memory.max").and_then(|value| {
            let value = value.trim();
            (value == "max" || value.parse::<u64>().is_ok()).then(|| value.to_owned())
        });
        let stat = read("memory.stat");
        let events = events(read("memory.events").as_deref());
        let local_events = self::events(read("memory.events.local").as_deref());
        let anon = values(stat.as_deref(), "anon");
        let file = values(stat.as_deref(), "file");
        let kernel = values(stat.as_deref(), "kernel");
        let baseline_events = initial.map_or_else(|| events.clone(), |value| value.events.clone());
        let local_baseline =
            initial.map_or_else(|| local_events.clone(), |value| value.local_events.clone());
        let status = if recreated {
            EvidenceStatus::Recreated
        } else if truncated {
            EvidenceStatus::Truncated
        } else if inode.is_none() {
            EvidenceStatus::Unavailable
        } else if [
            current,
            peak,
            anon,
            file,
            kernel,
            events.oom,
            local_events.oom,
        ]
        .iter()
        .any(Option::is_none)
            || limit.is_none()
        {
            EvidenceStatus::Partial
        } else {
            EvidenceStatus::Available
        };
        MemorySnapshot {
            role: role.into(),
            cgroup: if index == 0 {
                format!("{cgroup_root}/workload")
            } else {
                format!("{cgroup_root}/workload/{role}")
            },
            inode: initial.and_then(|value| value.inode).or(inode),
            status,
            current,
            peak,
            initial_limit: initial.map_or_else(|| limit.clone(), |value| value.limit.clone()),
            limit,
            anon,
            file,
            kernel,
            delta: if recreated {
                MemoryEvents::default()
            } else {
                events.delta(&baseline_events)
            },
            local_delta: if recreated {
                MemoryEvents::default()
            } else {
                local_events.delta(&local_baseline)
            },
            baseline: baseline_events,
            events,
            local_baseline,
            local_events,
        }
    })
}

fn boottime_us() -> u64 {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: clock_gettime initializes a valid stack timespec.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 {
        return u64::MAX;
    }
    (time.tv_sec as u64)
        .saturating_mul(1_000_000)
        .saturating_add(time.tv_nsec as u64 / 1000)
}

fn timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
