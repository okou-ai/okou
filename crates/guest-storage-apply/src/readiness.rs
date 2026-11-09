//! One operation's publication gates; the existing runtime owns their cleanup.

use crate::cleanup_directory::CleanupDirectory;
use guest_contracts::runtime_paths;
use guest_contracts::storage_manifest::Manifest;
use std::fs::OpenOptions;
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
#[cfg(target_os = "linux")]
use std::time::Instant;

#[cfg(target_os = "linux")]
mod watch;

#[cfg(target_os = "linux")]
pub(crate) fn install_notifications(events: std::os::fd::OwnedFd) -> io::Result<()> {
    watch::install(events)
}

pub(crate) struct Readiness {
    state: Arc<State>,
    #[cfg(target_os = "linux")]
    deadline: Instant,
    #[cfg(target_os = "linux")]
    events: watch::Events,
}

struct State {
    directory: CleanupDirectory,
    sources: Vec<(String, Arc<AtomicBool>)>,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

impl Readiness {
    pub(crate) fn prepare(manifest: &Manifest, runtime: Option<&Path>) -> io::Result<Option<Self>> {
        let timeout = manifest
            .archive_readiness
            .as_ref()
            .map_or(Duration::from_secs(60), |descriptor| {
                descriptor.wait_timeout()
            });
        Self::prepare_with_timeout(manifest, runtime, timeout)
    }

    fn prepare_with_timeout(
        manifest: &Manifest,
        runtime: Option<&Path>,
        _timeout: Duration,
    ) -> io::Result<Option<Self>> {
        let Some(descriptor) = &manifest.archive_readiness else {
            return Ok(None);
        };
        descriptor.validate(manifest).map_err(invalid)?;
        if !Self::eligible(manifest, runtime)? {
            return Err(invalid("pending archive layout is not eligible"));
        }
        let runtime = runtime.ok_or_else(|| invalid("missing private runtime"))?;
        let directory = descriptor.directory(runtime);
        runtime_paths::ensure_dir(&directory)?;
        let state = Arc::new(State {
            directory: CleanupDirectory::open(&directory)?,
            sources: descriptor
                .sources
                .iter()
                .map(|url| (url.clone(), Arc::new(AtomicBool::new(false))))
                .collect(),
        });
        // Watch before scanning so publication between the scan and the first
        // wait is retained by the kernel rather than lost.
        #[cfg(target_os = "linux")]
        let events = watch::arm(&state.directory.proc_path())?;
        state.scan()?;
        Ok(Some(Self {
            state,
            #[cfg(target_os = "linux")]
            deadline: Instant::now() + _timeout,
            #[cfg(target_os = "linux")]
            events,
        }))
    }

    pub(crate) fn eligible(manifest: &Manifest, runtime: Option<&Path>) -> io::Result<bool> {
        guest_telemetry::storage_eligibility::eligible(manifest, runtime, || Ok(()))
    }

    pub(crate) fn gate(&self, url: &str) -> Option<Arc<AtomicBool>> {
        self.state
            .sources
            .iter()
            .find(|(source, _)| source == url)
            .map(|(_, ready)| ready.clone())
    }
}

impl State {
    fn marker(&self, name: &str) -> io::Result<bool> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(self.directory.proc_path().join(name))
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() != 0 {
            return Err(invalid("invalid archive readiness marker"));
        }
        Ok(true)
    }

    fn scan(&self) -> io::Result<bool> {
        // An open directory fd delays IN_DELETE_SELF until its last close.
        // IN_ATTRIB still wakes us when unlink drops the directory's link count.
        if self.directory.metadata()?.nlink() == 0 {
            return Err(invalid("archive notification directory was removed"));
        }
        if self.marker("failed")? {
            return Err(io::Error::other("archive publisher failed"));
        }
        let mut changed = false;
        for (index, (_, gate)) in self.sources.iter().enumerate() {
            let ready = self.marker(&format!("{index}.ready"))?;
            let previous = gate.load(Ordering::Acquire);
            if previous && !ready {
                return Err(invalid("archive readiness was withdrawn"));
            }
            changed |= ready != previous;
            gate.store(ready, Ordering::Release);
        }
        Ok(changed)
    }

    #[cfg(target_os = "linux")]
    fn pending(&self) -> bool {
        self.sources
            .iter()
            .any(|(_, gate)| !gate.load(Ordering::Acquire))
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) struct Watcher;
#[cfg(not(target_os = "linux"))]
impl Watcher {
    pub(crate) fn finish(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[cfg(not(target_os = "linux"))]
impl Readiness {
    pub(crate) fn watch(
        self,
        _notify: impl Fn(io::Result<()>) + Send + 'static,
    ) -> io::Result<Watcher> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "archive readiness requires Linux",
        ))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
