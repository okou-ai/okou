use std::path::Path;

use super::{ProcessDiscovery, ProcessStatRead, discover_all_with_status_from};
use crate::process::read_process_stat_checked_from;

pub(crate) const FIRECRACKER_PID: u32 = 42;
pub(crate) const UNCERTAIN_STAT_FAULTS: [StatFault; 3] = [
    StatFault::PermissionDenied,
    StatFault::Emfile,
    StatFault::Invalid,
];

#[derive(Clone, Copy, Debug)]
pub(crate) enum StatFault {
    PermissionDenied,
    Emfile,
    Invalid,
    Missing,
    Terminal(char),
    NonFirecracker,
}

fn stat_bytes(state: char) -> Vec<u8> {
    let state = state.to_string();
    let mut fields = vec!["0"; 20];
    fields[0] = &state;
    fields[1] = "1";
    fields[2] = "42";
    fields[19] = "123456";
    format!("{FIRECRACKER_PID} (firecracker) {}", fields.join(" ")).into_bytes()
}

pub(crate) struct ProcfsFixture {
    proc_root: tempfile::TempDir,
}

impl ProcfsFixture {
    pub(crate) fn new(workspace: &Path) -> Self {
        let proc_root = tempfile::tempdir().unwrap();
        let pid_dir = proc_root.path().join(FIRECRACKER_PID.to_string());
        std::fs::create_dir(&pid_dir).unwrap();
        std::fs::write(pid_dir.join("cmdline"), b"firecracker\0--no-api\0").unwrap();
        std::fs::write(pid_dir.join("stat"), stat_bytes('S')).unwrap();
        std::os::unix::fs::symlink(workspace, pid_dir.join("cwd")).unwrap();
        Self { proc_root }
    }

    pub(crate) fn root(&self) -> &Path {
        self.proc_root.path()
    }

    pub(crate) async fn discover(&self) -> ProcessDiscovery {
        discover_all_with_status_from(self.root(), |pid| {
            read_process_stat_checked_from(self.root(), pid)
        })
        .await
    }

    /// Inject only stat-boundary outcomes after the requested successful reads.
    /// Scanning, cmdline parsing, cwd resolution, and discovery remain real.
    pub(crate) async fn discover_with_stat_fault(
        &self,
        successful_reads: usize,
        fault: StatFault,
    ) -> ProcessDiscovery {
        let mut reads = 0;
        discover_all_with_status_from(self.root(), |pid| {
            reads += 1;
            let inject_fault = reads > successful_reads;
            async move {
                if !inject_fault {
                    return read_process_stat_checked_from(self.root(), pid).await;
                }
                let pid_dir = self.root().join(pid.to_string());
                let stat_path = pid_dir.join("stat");
                match fault {
                    StatFault::PermissionDenied => {
                        return ProcessStatRead::Unreadable(std::io::Error::from_raw_os_error(
                            libc::EACCES,
                        ));
                    }
                    StatFault::Emfile => {
                        return ProcessStatRead::Unreadable(std::io::Error::from_raw_os_error(
                            libc::EMFILE,
                        ));
                    }
                    StatFault::Invalid => std::fs::write(&stat_path, b"malformed stat").unwrap(),
                    StatFault::Missing => {
                        if stat_path.exists() {
                            std::fs::remove_file(&stat_path).unwrap();
                        }
                    }
                    StatFault::Terminal(state) => {
                        std::fs::write(&stat_path, stat_bytes(state)).unwrap();
                    }
                    StatFault::NonFirecracker => {
                        std::fs::write(pid_dir.join("cmdline"), b"bash\0").unwrap();
                    }
                }
                read_process_stat_checked_from(self.root(), pid).await
            }
        })
        .await
    }
}
