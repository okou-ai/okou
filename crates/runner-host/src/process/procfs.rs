use std::path::{Path, PathBuf};

use tokio_util::sync::CancellationToken;

use super::types::{ProcessStat, process_stat_is_live};

mod handle;
pub use handle::ProcfsProcessHandle;

#[derive(Debug, Eq, PartialEq)]
enum CmdlineRead {
    Args(Vec<String>),
    Cancelled,
    Ignored,
    Missing,
    Unreadable(String),
}

fn parse_cmdline_bytes(bytes: &[u8]) -> Option<Vec<String>> {
    if bytes.is_empty() || !bytes.contains(&0) {
        return None;
    }
    let argv: Vec<String> = bytes
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    if argv.is_empty() { None } else { Some(argv) }
}

/// Read `/proc/{pid}/cmdline` as the NUL-separated argv.
///
/// Returns `None` when the file cannot be read, when its contents are empty or
/// NUL-free, or when every NUL-delimited segment is empty.
pub(super) async fn read_cmdline(proc_root: &Path, pid: u32) -> Option<Vec<String>> {
    let path = proc_root.join(pid.to_string()).join("cmdline");
    let bytes = tokio::fs::read(&path).await.ok()?;
    parse_cmdline_bytes(&bytes)
}

fn read_cmdline_for_scan(proc_root: &Path, pid: u32, cancel: &CancellationToken) -> CmdlineRead {
    let path = proc_root.join(pid.to_string()).join("cmdline");
    let result = match std::fs::read(&path) {
        Ok(bytes) => match parse_cmdline_bytes(&bytes) {
            Some(argv) => CmdlineRead::Args(argv),
            None => {
                cmdline_problem_for_scan(proc_root, pid, "cmdline is empty or NUL-free", cancel)
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => CmdlineRead::Missing,
        Err(e) => {
            let problem = format!("cmdline read failed: {e}");
            cmdline_problem_for_scan(proc_root, pid, &problem, cancel)
        }
    };
    if cancel.is_cancelled() {
        CmdlineRead::Cancelled
    } else {
        result
    }
}

fn cmdline_problem_for_scan(
    proc_root: &Path,
    pid: u32,
    problem: &str,
    cancel: &CancellationToken,
) -> CmdlineRead {
    if cancel.is_cancelled() {
        return CmdlineRead::Cancelled;
    }
    cmdline_problem_for_comm(read_process_comm_for_scan(proc_root, pid), problem)
}

fn cmdline_problem_for_comm(comm_read: ProcessCommRead, problem: &str) -> CmdlineRead {
    match comm_read {
        ProcessCommRead::Name {
            comm,
            live: Some(true),
        } if comm == b"firecracker" => CmdlineRead::Unreadable(problem.to_string()),
        ProcessCommRead::Name { comm, live: None } if comm == b"firecracker" => {
            CmdlineRead::Unreadable(format!("{problem}; stat parse failed"))
        }
        ProcessCommRead::Name { .. } => CmdlineRead::Ignored,
        ProcessCommRead::Missing => CmdlineRead::Missing,
        ProcessCommRead::Unreadable(stat_error) => {
            CmdlineRead::Unreadable(format!("{problem}; stat read failed: {stat_error}"))
        }
        ProcessCommRead::Invalid => {
            CmdlineRead::Unreadable(format!("{problem}; stat parse failed"))
        }
    }
}

/// Read `/proc/{pid}/stat` and extract the PPid field.
pub(super) async fn read_ppid(pid: u32) -> Option<u32> {
    read_ppid_from(Path::new("/proc"), pid).await
}

pub(super) async fn read_ppid_from(proc_root: &Path, pid: u32) -> Option<u32> {
    let path = proc_root.join(pid.to_string()).join("stat");
    let content = tokio::fs::read(&path).await.ok()?;
    parse_process_ppid(&content)
}

/// Return the byte fields after the `/proc/{pid}/stat` comm field.
///
/// Format: `pid (comm) state ppid pgrp ...`
/// The comm field may contain spaces and parentheses, so we find the
/// last `)` to skip past it reliably.
fn stat_fields_after_comm(content: &[u8]) -> Option<impl Iterator<Item = &[u8]> + '_> {
    let close_paren = content.iter().rposition(|byte| *byte == b')')?;
    let after_comm = content.get(close_paren + 1..)?;
    Some(
        after_comm
            .split(|byte| byte.is_ascii_whitespace())
            .filter(|field| !field.is_empty()),
    )
}

fn process_comm(content: &[u8]) -> Option<&[u8]> {
    let open_paren = content.iter().position(|byte| *byte == b'(')?;
    let close_paren = content.iter().rposition(|byte| *byte == b')')?;
    if close_paren <= open_paren {
        return None;
    }
    content.get(open_paren + 1..close_paren)
}

enum ProcessCommRead {
    Name { comm: Vec<u8>, live: Option<bool> },
    Missing,
    Unreadable(std::io::Error),
    Invalid,
}

fn read_process_comm_for_scan(proc_root: &Path, pid: u32) -> ProcessCommRead {
    let path = proc_root.join(pid.to_string()).join("stat");
    match std::fs::read(&path) {
        Ok(content) => {
            let Some(comm) = process_comm(&content) else {
                return ProcessCommRead::Invalid;
            };
            ProcessCommRead::Name {
                comm: comm.to_vec(),
                live: parse_process_stat(&content).map(|stat| process_stat_is_live(&stat)),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ProcessCommRead::Missing,
        Err(e) => ProcessCommRead::Unreadable(e),
    }
}

fn parse_char_field(field: &[u8]) -> Option<char> {
    let [state] = field else {
        return None;
    };
    state.is_ascii().then_some(char::from(*state))
}

fn parse_u32_field(field: &[u8]) -> Option<u32> {
    std::str::from_utf8(field).ok()?.parse().ok()
}

fn parse_i32_field(field: &[u8]) -> Option<i32> {
    std::str::from_utf8(field).ok()?.parse().ok()
}

fn parse_u64_field(field: &[u8]) -> Option<u64> {
    std::str::from_utf8(field).ok()?.parse().ok()
}

fn parse_process_ppid(content: &[u8]) -> Option<u32> {
    let mut fields = stat_fields_after_comm(content)?;
    let _state = fields.next()?;
    parse_u32_field(fields.next()?)
}

/// Parse process facts from `/proc/{pid}/stat` content.
fn parse_process_stat(content: &[u8]) -> Option<ProcessStat> {
    let mut fields = stat_fields_after_comm(content)?;

    // After the comm field, index 0 is stat field 3 (`state`), index 1 is
    // field 4 (`ppid`), index 2 is field 5 (`pgrp`), and index 19 is field
    // 22 (`starttime`).
    let state = parse_char_field(fields.next()?)?;
    let ppid = parse_u32_field(fields.next()?)?;
    // do_task_stat can retain its signed -1 PGID sentinel after sighand is
    // released. State is sampled separately, so -1 alone does not prove exit.
    let pgid = parse_i32_field(fields.next()?)?;
    if pgid < -1 {
        return None;
    }
    let starttime = parse_u64_field(fields.nth(16)?)?;

    Some(ProcessStat {
        state,
        ppid,
        pgid,
        starttime,
    })
}

#[derive(Debug)]
pub enum ProcessStatRead {
    Found(ProcessStat),
    Missing,
    Unreadable(std::io::Error),
    Invalid,
}

fn classify_process_stat_read(result: std::io::Result<Vec<u8>>) -> ProcessStatRead {
    match result {
        Ok(content) => match parse_process_stat(&content) {
            Some(stat) => ProcessStatRead::Found(stat),
            None => ProcessStatRead::Invalid,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ProcessStatRead::Missing,
        Err(error) => ProcessStatRead::Unreadable(error),
    }
}

/// Read `/proc/{pid}/stat` without conflating disappearance and read failures.
pub async fn read_process_stat_checked(pid: u32) -> ProcessStatRead {
    read_process_stat_checked_from(Path::new("/proc"), pid).await
}

pub async fn read_process_stat_checked_from(proc_root: &Path, pid: u32) -> ProcessStatRead {
    let path = proc_root.join(pid.to_string()).join("stat");
    classify_process_stat_read(tokio::fs::read(&path).await)
}

/// Blocking variant for callers that already run a complete procfs traversal
/// on a blocking thread.
pub fn read_process_stat_checked_blocking(pid: u32) -> ProcessStatRead {
    let path = format!("/proc/{pid}/stat");
    classify_process_stat_read(std::fs::read(&path))
}

/// Read `/proc/{pid}/stat` and extract process facts.
pub async fn read_process_stat(pid: u32) -> Option<ProcessStat> {
    match read_process_stat_checked(pid).await {
        ProcessStatRead::Found(stat) => Some(stat),
        ProcessStatRead::Missing | ProcessStatRead::Unreadable(_) | ProcessStatRead::Invalid => {
            None
        }
    }
}

/// Read `/proc/{pid}/cwd` symlink to get the process working directory.
pub(super) async fn read_cwd(proc_root: &Path, pid: u32) -> Option<PathBuf> {
    let link = proc_root.join(pid.to_string()).join("cwd");
    tokio::fs::read_link(&link).await.ok()
}

/// Read `/proc/{pid}/cgroup` and extract the systemd service unit name.
///
/// Example content: `0::/system.slice/vm0-runner-v0.2.0.service\n`
/// Returns `Some("vm0-runner-v0.2.0")` for the above.
pub async fn read_service_unit(pid: u32) -> Option<String> {
    let path = format!("/proc/{pid}/cgroup");
    let content = tokio::fs::read_to_string(&path).await.ok()?;
    parse_service_unit_from_cgroup(&content)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum CgroupPathPriority {
    Fallback,
    Systemd,
}

fn parse_service_unit_from_cgroup(content: &str) -> Option<String> {
    let mut saw_systemd_path = false;
    let mut fallback_unit = None;
    for line in content.lines() {
        let Some((priority, path)) = cgroup_path_from_line(line) else {
            continue;
        };
        if priority == CgroupPathPriority::Systemd {
            saw_systemd_path = true;
            if let Some(unit) = service_unit_from_cgroup_path(path) {
                return Some(unit);
            }
            continue;
        }
        if let Some(unit) = service_unit_from_cgroup_path(path) {
            fallback_unit.get_or_insert(unit);
        }
    }
    if saw_systemd_path {
        None
    } else {
        fallback_unit
    }
}

fn cgroup_path_from_line(line: &str) -> Option<(CgroupPathPriority, &str)> {
    let mut parts = line.splitn(3, ':');
    let hierarchy_id = parse_cgroup_hierarchy_id(parts.next()?)?;
    let controllers = parts.next()?;
    let path = parts.next()?;
    if !path.starts_with('/') {
        return None;
    }

    let is_v2 = hierarchy_id == 0 && controllers.is_empty();
    let is_v1 = hierarchy_id != 0
        && !controllers.is_empty()
        && controllers
            .split(',')
            .all(|controller| !controller.is_empty());
    if !is_v2 && !is_v1 {
        return None;
    }

    let priority = if is_v2
        || controllers
            .split(',')
            .any(|controller| controller == "name=systemd")
    {
        CgroupPathPriority::Systemd
    } else {
        CgroupPathPriority::Fallback
    };
    Some((priority, path))
}

fn parse_cgroup_hierarchy_id(field: &str) -> Option<u32> {
    if field.is_empty() || !field.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if field.len() > 1 && field.starts_with('0') {
        return None;
    }
    field.parse().ok()
}

fn service_unit_from_cgroup_path(path: &str) -> Option<String> {
    path.split('/')
        .rev()
        .filter(|segment| !segment.is_empty())
        .find_map(|segment| {
            let unit = segment.strip_suffix(".service")?;
            if unit.is_empty() {
                None
            } else {
                Some(unit.to_string())
            }
        })
}

/// Scan `/proc` for process argvs and track Firecracker discovery uncertainty.
pub(super) struct ProcCmdlineScan {
    /// Cmdlines that were successfully parsed as NUL-separated argvs.
    pub(super) entries: Vec<(u32, Vec<String>)>,
    /// Whether the scan encountered no uncertainty that callers must treat as
    /// a potentially undiscovered live Firecracker.
    ///
    /// This is false when opening or iterating `/proc` fails, when an
    /// unreadable or unparseable cmdline belongs to a live Firecracker, or when
    /// unavailable or malformed `/proc/{pid}/stat` facts cannot rule one out.
    /// Empty and NUL-free cmdlines use this same classification. A disappeared
    /// PID, zombie or otherwise terminal Firecracker, or known non-Firecracker
    /// process does not make the scan incomplete. This is not a guarantee that
    /// every non-Firecracker cmdline was readable.
    pub(super) complete: bool,
}

struct ProcDirEntryReader {
    #[cfg(test)]
    after_entry: Option<Box<dyn FnMut() -> std::io::Result<()> + Send>>,
}

impl ProcDirEntryReader {
    const fn new() -> Self {
        Self {
            #[cfg(test)]
            after_entry: None,
        }
    }

    #[cfg(test)]
    fn after_entry(after_entry: impl FnMut() -> std::io::Result<()> + Send + 'static) -> Self {
        Self {
            after_entry: Some(Box::new(after_entry)),
        }
    }

    fn next_entry(
        &mut self,
        entries: &mut std::fs::ReadDir,
    ) -> std::io::Result<Option<std::fs::DirEntry>> {
        let entry = entries.next().transpose()?;

        #[cfg(test)]
        if entry.is_some()
            && let Some(after_entry) = &mut self.after_entry
        {
            after_entry()?;
        }

        Ok(entry)
    }
}

pub(super) async fn scan_proc_cmdlines(proc_root: &Path) -> ProcCmdlineScan {
    scan_proc_cmdlines_with_reader(
        proc_root,
        ProcDirEntryReader::new(),
        CancellationToken::new(),
        #[cfg(test)]
        None,
    )
    .await
}

async fn scan_proc_cmdlines_with_reader(
    proc_root: &Path,
    entry_reader: ProcDirEntryReader,
    cancel: CancellationToken,
    #[cfg(test)] task_submissions: Option<&std::sync::atomic::AtomicUsize>,
) -> ProcCmdlineScan {
    let proc_root = proc_root.to_path_buf();
    let cancel_on_drop = cancel.clone().drop_guard();

    #[cfg(test)]
    if let Some(task_submissions) = task_submissions {
        task_submissions.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    let result = tokio::task::spawn_blocking(move || {
        scan_proc_cmdlines_blocking(&proc_root, entry_reader, &cancel)
    })
    .await;
    let _cancel = cancel_on_drop.disarm();
    match result {
        Ok(scan) => scan,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

fn scan_proc_cmdlines_blocking(
    proc_root: &Path,
    mut entry_reader: ProcDirEntryReader,
    cancel: &CancellationToken,
) -> ProcCmdlineScan {
    let mut result = Vec::new();
    let mut complete = true;
    if cancel.is_cancelled() {
        return ProcCmdlineScan {
            entries: result,
            complete: false,
        };
    }
    let mut entries = match std::fs::read_dir(proc_root) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(
                "scan_proc_cmdlines: cannot read {}: {e}",
                proc_root.display()
            );
            return ProcCmdlineScan {
                entries: result,
                complete: false,
            };
        }
    };
    loop {
        if cancel.is_cancelled() {
            complete = false;
            break;
        }
        let entry = match entry_reader.next_entry(&mut entries) {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(e) => {
                tracing::warn!(
                    "scan_proc_cmdlines: read entry in {}: {e}",
                    proc_root.display()
                );
                complete = false;
                continue;
            }
        };
        if cancel.is_cancelled() {
            complete = false;
            break;
        }
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        let Ok(pid) = name_str.parse::<u32>() else {
            continue;
        };
        match read_cmdline_for_scan(proc_root, pid, cancel) {
            CmdlineRead::Args(argv) => result.push((pid, argv)),
            CmdlineRead::Cancelled => {
                complete = false;
                break;
            }
            CmdlineRead::Ignored | CmdlineRead::Missing => {}
            CmdlineRead::Unreadable(e) => {
                tracing::warn!(
                    "scan_proc_cmdlines: cannot read {}/{pid}/cmdline: {e}",
                    proc_root.display()
                );
                complete = false;
            }
        }
    }
    ProcCmdlineScan {
        entries: result,
        complete,
    }
}

#[cfg(test)]
mod tests;
