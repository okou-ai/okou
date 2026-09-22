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
mod tests {
    use super::*;
    use std::io::Write;

    struct Fixture {
        _directory: tempfile::TempDir,
        root: PathBuf,
        monitor: EvidenceMonitor,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().join("exec-281-10-3");
            for role in ["", "runtime", "tools"] {
                let path = root.join("workload").join(role);
                fs::create_dir_all(&path).unwrap();
                fs::write(path.join("memory.current"), "4096").unwrap();
                fs::write(path.join("memory.peak"), "8192").unwrap();
                fs::write(path.join("memory.max"), "16384").unwrap();
                fs::write(
                    path.join("memory.stat"),
                    "anon 1024\nfile 2048\nkernel 1024\n",
                )
                .unwrap();
                for file in ["memory.events", "memory.events.local"] {
                    fs::write(
                        path.join(file),
                        "high 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
                    )
                    .unwrap();
                }
            }
            let mut monitor = EvidenceMonitor::without_kernel_for_test(root.clone());
            monitor.evidence.started_boottime_us = 1000;
            Self {
                _directory: directory,
                root,
                monitor,
            }
        }

        fn counters(&self, count: u64) {
            fs::write(
                self.root.join("workload/memory.events"),
                format!("high 0\nmax 2\noom {count}\noom_kill {count}\noom_group_kill 0\n"),
            )
            .unwrap();
        }

        fn kernel(&mut self, sequence: u64, time: u64, constraint: &str) {
            self.record(&format!("6,{sequence},{time},-;oom-kill:constraint={constraint},nodemask=(null),cpuset=/,mems_allowed=0,task_memcg=/vm0-exec/exec-281-10-3/workload/runtime,task=node,pid=999999,uid=1000\n"));
        }

        fn record(&mut self, record: &str) {
            let mut file = tempfile::tempfile().unwrap();
            file.write_all(record.as_bytes()).unwrap();
            file.rewind().unwrap();
            self.monitor.kernel = Some(file);
            self.monitor.kernel_status = EvidenceStatus::Available;
        }
    }

    #[test]
    fn collector_rejects_paths_outside_the_exact_operation_mount() {
        let directory = tempfile::tempdir().unwrap();
        for root in [
            "/tmp/vm0-exec/exec-281-10-3",
            "/sys/fs/cgroup2/vm0-exec/exec-281-10-3",
            "/sys/fs/cgroup/other/exec-281-10-3",
            "/sys/fs/cgroup/vm0-exec/exec-",
            "/sys/fs/cgroup/vm0-exec/exec-private",
            "/sys/fs/cgroup/vm0-exec/exec-281-10-3/../exec-1",
            "/sys/fs/cgroup/vm0-exec/exec-281-10-3/workload",
            "/sys/fs//cgroup/vm0-exec/exec-281-10-3",
            "/sys/fs/cgroup/./vm0-exec/exec-281-10-3",
            "sys/fs/cgroup/vm0-exec/exec-281-10-3",
        ] {
            assert!(
                EvidenceMonitor::with_sources(
                    Path::new(root),
                    directory.path().to_path_buf(),
                    Err(io::Error::from(io::ErrorKind::NotFound)),
                    1000,
                )
                .is_none(),
                "accepted unowned root: {root}"
            );
        }
        assert!(operation_cgroup(directory.path()).is_none());
        assert!(
            operation_cgroup(Path::new(&format!(
                "/sys/fs/cgroup/vm0-exec/exec-{}",
                "1".repeat(256)
            )))
            .is_none()
        );
    }

    #[test]
    fn canonical_collector_identity_matches_independent_kernel_paths() {
        for (path, memcg) in [
            (
                "/vm0-exec/exec-281-10-3/workload",
                "/vm0-exec/exec-281-10-3/workload",
            ),
            (
                "/vm0-exec/exec-281-10-3/workload/runtime",
                "/vm0-exec/exec-281-10-3/workload",
            ),
            (
                "/vm0-exec/exec-281-10-3/workload/tools",
                "/vm0-exec/exec-281-10-3/workload",
            ),
            (
                "/vm0-exec/exec-281-10-3/workload/tools/tool-45-6",
                "/vm0-exec/exec-281-10-3/workload",
            ),
            ("/vm0-exec/exec-281-10-3/control", "/vm0-exec/exec-281-10-3"),
        ] {
            for (constraint, trigger) in [("CONSTRAINT_NONE", "/"), ("CONSTRAINT_MEMCG", memcg)] {
                let mut fixture = Fixture::new();
                fixture.record(&format!("6,10,2000,-;oom-kill:constraint={constraint},oom_memcg={trigger},task_memcg={path},task=node,pid=999999,uid=1000\n"));
                let captured = fixture.monitor.capture(CaptureReason::Sample);
                assert_eq!(captured.incidents.len(), 1, "missing victim in {path}");
                let event = &captured.incidents[0].kernel_events[0];
                assert_eq!(event.task_cgroup, path);
                assert_eq!(event.oom_cgroup.as_deref(), Some(trigger));
                assert_eq!(event.constraint, constraint);
                assert_eq!(event.victim_pid, 999999);
            }
        }
        for path in [
            "/vm0-exec/exec-281-10-30/workload/runtime",
            "vm0-exec/exec-281-10-3/workload/runtime",
            "//vm0-exec/exec-281-10-3/workload/runtime",
            "/vm0-exec/exec-281-10-3/workload/tools/tool-1/../runtime",
        ] {
            let mut fixture = Fixture::new();
            fixture.record(&format!("6,10,2000,-;oom-kill:constraint=CONSTRAINT_NONE,task_memcg={path},task=node,pid=999999,uid=1000\n"));
            let captured = fixture.monitor.capture(CaptureReason::Sample);
            assert!(captured.incidents.is_empty());
            assert_eq!(captured.kernel_status, EvidenceStatus::Uncorrelated);
        }
    }

    #[test]
    fn collector_output_matches_api_fixture() {
        // This is the producer half of the cross-language contract test. Only
        // nondeterministic UUIDs, wall-clock times and filesystem inodes are
        // replaced for comparison; cgroup paths and counter values are intact.
        fn stable(mut evidence: OomEvidence) -> OomEvidence {
            fn stable_inodes(groups: &mut [MemorySnapshot; 3]) {
                for (index, group) in groups.iter_mut().enumerate() {
                    group.inode = group.inode.map(|_| index as u64 + 1);
                }
            }
            evidence.operation_id = "11111111-1111-4111-8111-111111111111".into();
            evidence.guest_boot_id = Some("22222222-2222-4222-8222-222222222222".into());
            evidence.sampled_at = "2026-09-09T09:00:00.000Z".into();
            stable_inodes(&mut evidence.groups);
            for (index, incident) in evidence.incidents.iter_mut().enumerate() {
                incident.id = format!("{}:{}", evidence.operation_id, index + 1);
                incident.captured_at = evidence.sampled_at.clone();
                stable_inodes(&mut incident.groups);
            }
            evidence
        }
        let mut fixture = Fixture::new();
        fs::remove_file(fixture.root.join("workload/runtime/memory.peak")).unwrap();
        fs::remove_file(fixture.root.join("workload/tools/memory.events.local")).unwrap();
        fixture.monitor = EvidenceMonitor::without_kernel_for_test(fixture.root.clone());
        fixture.monitor.evidence.started_boottime_us = 1000;
        let initial = fixture.monitor.capture(CaptureReason::Sample);
        fixture.counters(1);
        fixture.kernel(10, 2000, "CONSTRAINT_MEMCG");
        let sample = fixture.monitor.capture(CaptureReason::Sample);
        let cleanup = fixture.monitor.capture(CaptureReason::Cleanup);
        for evidence in [&initial, &sample, &cleanup] {
            for groups in std::iter::once(&evidence.groups)
                .chain(evidence.incidents.iter().map(|incident| &incident.groups))
            {
                assert_eq!(groups[0].cgroup, "/vm0-exec/exec-281-10-3/workload");
                assert_eq!(groups[1].cgroup, "/vm0-exec/exec-281-10-3/workload/runtime");
                assert_eq!(groups[2].cgroup, "/vm0-exec/exec-281-10-3/workload/tools");
                assert_eq!(groups[0].current, Some(4096));
                assert_eq!(groups[1].peak, None);
                assert_eq!(groups[2].local_events.oom, None);
            }
        }
        assert_eq!(sample.incidents, cleanup.incidents);
        assert_eq!(sample.incidents[0].kernel_events.len(), 1);
        let generated = serde_json::json!({
            "initial": stable(initial),
            "sample": stable(sample),
            "cleanup": stable(cleanup),
        });
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/oom-evidence-collector.json");
        if std::env::var_os("UPDATE_OOM_COLLECTOR_FIXTURE").is_some() {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                &path,
                serde_json::to_string_pretty(&generated).unwrap() + "\n",
            )
            .unwrap();
        }
        let checked: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(generated, checked, "regenerate the collector API fixture");
    }

    #[test]
    fn kernel_reader_reports_denied_overwritten_and_expired_budgets() {
        struct Source(std::collections::VecDeque<i32>);
        impl Read for Source {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::from_raw_os_error(
                    self.0.pop_front().expect("reader exceeded fixture"),
                ))
            }
        }
        impl Seek for Source {
            fn seek(&mut self, _from: SeekFrom) -> io::Result<u64> {
                Ok(0)
            }
        }
        for (errors, expected) in [
            (vec![libc::EACCES], EvidenceStatus::Denied),
            (vec![libc::EPIPE, libc::EAGAIN], EvidenceStatus::Overwritten),
            (vec![libc::EINVAL], EvidenceStatus::Truncated),
            (vec![libc::EAGAIN], EvidenceStatus::Missing),
        ] {
            let mut source = Source(errors.into());
            let (_, status) = read_kernel_records(
                &mut source,
                &mut EvidenceStatus::Available,
                &mut None,
                0,
                "/vm0-exec/exec-1/workload",
                Instant::now() + CAPTURE_BUDGET,
            );
            assert_eq!(status, expected);
            assert!(source.0.is_empty());
        }
        let (_, status) = read_kernel_records(
            &mut Source(Default::default()),
            &mut EvidenceStatus::Available,
            &mut None,
            0,
            "/vm0-exec/exec-1/workload",
            Instant::now(),
        );
        assert_eq!(
            status,
            EvidenceStatus::Truncated,
            "expired capture never starts another read"
        );
    }

    #[test]
    fn kernel_record_and_event_caps_bound_a_busy_source() {
        use std::os::fd::OwnedFd;
        use std::os::unix::net::UnixDatagram;
        let mut fixture = Fixture::new();
        let (reader, writer) = UnixDatagram::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        let fd: OwnedFd = reader.into();
        fixture.monitor.kernel = Some(File::from(fd));
        fixture.monitor.kernel_status = EvidenceStatus::Available;
        for seq in 1..=MAX_KERNEL_EVENTS + 1 {
            writer.send(format!("6,{seq},2000,-;oom-kill:constraint=CONSTRAINT_NONE,task_memcg=/vm0-exec/exec-281-10-3/workload/runtime,task=node,pid=999999,uid=1000").as_bytes()).unwrap();
        }
        let captured = fixture.monitor.capture(CaptureReason::Sample);
        assert_eq!(captured.incidents[0].kernel_events.len(), MAX_KERNEL_EVENTS);
        assert_eq!(
            captured.incidents[0].kernel_status,
            EvidenceStatus::Truncated
        );
        for seq in 100..100 + KERNEL_RECORDS + 1 {
            writer
                .send(format!("6,{seq},2000,-;ordinary kernel record").as_bytes())
                .unwrap();
        }
        let (_, status) = fixture
            .monitor
            .read_kernel(Instant::now() + Duration::from_secs(1));
        assert_eq!(status, EvidenceStatus::Truncated);
        assert_eq!(
            fixture.monitor.last_sequence,
            Some((100 + KERNEL_RECORDS - 1) as u64)
        );
    }

    #[test]
    fn captures_cgroup_and_global_victims_without_proc_even_with_oom_counters() {
        for constraint in ["CONSTRAINT_MEMCG", "CONSTRAINT_NONE"] {
            let mut fixture = Fixture::new();
            fixture.counters(1);
            fixture.kernel(10, 2000, constraint);
            let captured = fixture.monitor.capture(CaptureReason::Sample);
            let incident = &captured.incidents[0];
            assert_eq!(incident.kernel_events[0].victim_pid, 999999);
            assert_eq!(incident.kernel_events[0].constraint, constraint);
            assert_eq!(incident.kernel_events[0].source, "guest");
            assert_eq!(incident.groups[0].delta.oom_kill, Some(1));
            assert_eq!(incident.groups[0].initial_limit.as_deref(), Some("16384"));
            assert_eq!(incident.groups[0].anon, Some(1024));
            assert!(incident.after_observation && incident.before_cleanup);
            assert!(serde_json::to_vec(&captured).unwrap().len() < MAX_EVIDENCE_BYTES);
        }
    }

    #[test]
    fn recovered_counter_after_missing_read_still_records_tool_oom() {
        let mut fixture = Fixture::new();
        fs::remove_file(fixture.root.join("workload/memory.events")).unwrap();
        let missing = fixture.monitor.capture(CaptureReason::Sample);
        assert_eq!(missing.groups[0].events.oom_kill, None);
        assert!(missing.incidents.is_empty());
        fixture.counters(1);
        let restored = fixture.monitor.capture(CaptureReason::Sample);
        assert_eq!(restored.incidents.len(), 1);
        assert_eq!(restored.incidents[0].groups[0].delta.oom_kill, Some(1));
        assert_eq!(
            restored.incidents[0].kernel_status,
            EvidenceStatus::Unavailable
        );
        assert_eq!(
            fixture
                .monitor
                .capture(CaptureReason::Cleanup)
                .incidents
                .len(),
            1
        );
    }

    #[test]
    fn kernel_first_kill_counter_tail_reuses_incident_but_new_oom_is_distinct() {
        for constraint in ["CONSTRAINT_NONE", "CONSTRAINT_MEMCG"] {
            let mut fixture = Fixture::new();
            let oom = u64::from(constraint == "CONSTRAINT_MEMCG");
            let events_path = fixture.root.join("workload/memory.events");
            let write_events = |kills, attempts| {
                fs::write(
                    &events_path,
                    format!("oom {attempts}\noom_kill {kills}\noom_group_kill 0\n"),
                )
                .unwrap();
            };
            write_events(0, oom);
            fixture.kernel(10, 2000, constraint);
            let first = fixture.monitor.capture(CaptureReason::Sample);
            write_events(1, oom);
            let tail = fixture.monitor.capture(CaptureReason::Sample);
            assert_eq!(
                tail.incidents, first.incidents,
                "original snapshot and time remain true"
            );
            assert_eq!(tail.groups[0].events.oom_kill, Some(1));
            write_events(2, oom + 1);
            fixture.kernel(11, 3000, constraint);
            let second = fixture.monitor.capture(CaptureReason::Sample);
            assert_eq!(second.incidents.len(), 2);
            assert_ne!(second.incidents[0].id, second.incidents[1].id);
        }
    }

    #[test]
    fn uncertain_kernel_gap_and_control_victim_cannot_consume_workload_counter() {
        for status in [EvidenceStatus::Unavailable, EvidenceStatus::Overwritten] {
            let mut fixture = Fixture::new();
            fixture.kernel(10, 2000, "CONSTRAINT_NONE");
            fixture.monitor.capture(CaptureReason::Sample);
            fixture.monitor.kernel = None;
            fixture.monitor.kernel_status = status;
            fs::write(
                fixture.root.join("workload/memory.events"),
                "oom 0\noom_kill 1\noom_group_kill 0\n",
            )
            .unwrap();
            assert_eq!(
                fixture
                    .monitor
                    .capture(CaptureReason::Sample)
                    .incidents
                    .len(),
                2
            );
        }
        let mut fixture = Fixture::new();
        fixture.record("6,10,2000,-;oom-kill:constraint=CONSTRAINT_NONE,task_memcg=/vm0-exec/exec-281-10-3/control,task=guest-agent,pid=999999,uid=1000\n");
        fixture.monitor.capture(CaptureReason::Sample);
        fs::write(
            fixture.root.join("workload/memory.events"),
            "oom 0\noom_kill 1\noom_group_kill 0\n",
        )
        .unwrap();
        assert_eq!(
            fixture
                .monitor
                .capture(CaptureReason::Sample)
                .incidents
                .len(),
            2
        );
    }

    #[test]
    fn recovered_tool_oom_error_and_cleanup_share_one_incident() {
        let mut fixture = Fixture::new();
        fixture.counters(1);
        let first = fixture.monitor.capture(CaptureReason::Sample);
        assert_eq!(first.incidents.len(), 1);
        assert!(first.incidents[0].kernel_events.is_empty());
        fixture.kernel(10, 2000, "CONSTRAINT_MEMCG");
        let exit = fixture.monitor.capture(CaptureReason::CliError);
        let cleanup = fixture.monitor.capture(CaptureReason::Cleanup);
        assert_eq!(exit.incidents.len(), 1);
        assert_eq!(cleanup.incidents.len(), 1);
        assert_eq!(first.incidents[0].id, cleanup.incidents[0].id);
        assert_eq!(cleanup.incidents[0].kernel_events.len(), 1);
        fs::remove_dir_all(&fixture.root).unwrap();
        assert_eq!(cleanup.incidents[0].groups[0].current, Some(4096));
        assert_eq!(cleanup.incidents[0].groups[0].local_delta.oom, Some(0));
    }

    #[test]
    fn rejects_stale_unrelated_host_and_userspace_records() {
        let mut fixture = Fixture::new();
        fixture.kernel(10, 999, "CONSTRAINT_MEMCG");
        assert!(
            fixture
                .monitor
                .capture(CaptureReason::Sample)
                .incidents
                .is_empty()
        );
        for record in [
            "6,11,2000,-;Killed\n",
            "6,12,2000,-;oom-kill:constraint=CONSTRAINT_NONE,task_memcg=/host/firecracker,task=firecracker,pid=55,uid=0\n",
            "6,13,2000,-;oom-kill:constraint=CONSTRAINT_MEMCG,task_memcg=/vm0-exec/exec-1-2-3/workload/runtime,task=node,pid=55,uid=0\n",
        ] {
            fixture.record(record);
            assert!(
                fixture
                    .monitor
                    .capture(CaptureReason::Sample)
                    .incidents
                    .is_empty()
            );
        }
        fixture.kernel(14, 3000, "CONSTRAINT_NONE");
        let mut text = String::new();
        fixture
            .monitor
            .kernel
            .as_mut()
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        fixture.record(&text.replacen("6,", "14,", 1));
        assert!(
            fixture
                .monitor
                .capture(CaptureReason::Sample)
                .incidents
                .is_empty()
        );
        let candidate = fixture.monitor.capture(CaptureReason::CliError);
        assert!(candidate.incidents[0].kernel_events.is_empty());
        assert!(!candidate.incidents[0].groups[0].delta.has_oom());
    }

    #[test]
    fn duplicate_kernel_fields_cannot_forge_victim_identity() {
        assert!(parse_oom("oom-kill:constraint=CONSTRAINT_NONE,task_memcg=/g/runtime,task=evil,pid=1,pid=99,uid=1000", 1, 2, "/g").is_none());
        assert!(parse_oom("oom-kill:constraint=CONSTRAINT_NONE,task_memcg=/g/runtime,task=evil\nname,pid=99,uid=1000", 1, 2, "/g").is_none());
    }

    #[test]
    fn repeated_operations_and_recreated_cgroups_do_not_inherit_counters() {
        let mut fixture = Fixture::new();
        fixture.counters(5);
        let mut next = EvidenceMonitor::without_kernel_for_test(fixture.root.clone());
        assert_ne!(
            fixture.monitor.evidence.operation_id,
            next.evidence.operation_id
        );
        assert!(next.capture(CaptureReason::Sample).incidents.is_empty());
        fs::rename(
            fixture.root.join("workload"),
            fixture.root.join("old-workload"),
        )
        .unwrap();
        fs::create_dir(fixture.root.join("workload")).unwrap();
        fixture.counters(9);
        let capture = fixture.monitor.capture(CaptureReason::Sample);
        assert!(capture.incidents.is_empty());
        assert_eq!(capture.groups[0].status, EvidenceStatus::Recreated);
        assert_eq!(capture.groups[0].delta.oom_kill, None);
    }

    #[test]
    fn unsupported_and_oversized_sources_are_explicit_and_retention_is_bounded() {
        let mut fixture = Fixture::new();
        fs::remove_file(fixture.root.join("workload/memory.peak")).unwrap();
        fs::write(
            fixture.root.join("workload/memory.stat"),
            "x".repeat(FILE_BYTES + 1),
        )
        .unwrap();
        let first = fixture.monitor.capture(CaptureReason::Sample);
        assert_eq!(first.groups[0].peak, None);
        assert_eq!(first.groups[0].anon, None);
        assert_eq!(first.groups[0].status, EvidenceStatus::Truncated);
        for count in 1..=10 {
            fixture.counters(count);
            fixture.monitor.capture(CaptureReason::Sample);
        }
        let capture = fixture.monitor.capture(CaptureReason::Cleanup);
        assert_eq!(capture.incidents.len(), MAX_INCIDENTS);
        assert_eq!(capture.dropped_incidents, 6);
        assert!(serde_json::to_vec(&capture).unwrap().len() < MAX_EVIDENCE_BYTES);
        let deadline = snapshots(
            &fixture.root,
            &fixture.monitor.cgroup_root,
            Some(&fixture.monitor.initial),
            Instant::now(),
        );
        assert!(
            deadline
                .iter()
                .all(|group| group.status == EvidenceStatus::Truncated)
        );
    }
}
