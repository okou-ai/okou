//! One operation's publication gates; the existing runtime owns their cleanup.

use crate::cleanup_directory::CleanupDirectory;
use crate::instructions::InstructionFilename;
use guest_contracts::runtime_paths;
use guest_contracts::storage_manifest::Manifest;
use guest_contracts::storage_paths::normalize_path;
use std::fs::OpenOptions;
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
#[cfg(target_os = "linux")]
use std::time::Instant;

#[cfg(target_os = "linux")]
mod watch;

pub(crate) struct Readiness {
    state: Arc<State>,
    #[cfg(target_os = "linux")]
    deadline: Instant,
    #[cfg(target_os = "linux")]
    events: std::fs::File,
}

struct State {
    directory: CleanupDirectory,
    sources: Vec<(String, Arc<AtomicBool>)>,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn overlaps(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn has_cleanup_ancestor(manifest: &Manifest, target: &Path) -> bool {
    manifest
        .cleanup_paths
        .iter()
        .map(PathBuf::from)
        .chain(manifest.instruction_cleanups.iter().flat_map(|entry| {
            InstructionFilename::ALL
                .into_iter()
                .filter(move |name| {
                    entry
                        .target_filename
                        .as_deref()
                        .is_none_or(|target| target == name.as_str())
                })
                .map(move |name| Path::new(&entry.mount_path).join(name.as_str()))
        }))
        .any(|root| {
            let root = normalize_path(&root);
            root.is_absolute() && target.starts_with(root)
        })
}

// Resolve missing leaves through their existing ancestor, retaining its physical
// identity so an input alias cannot erase the private notification directory.
fn physical_path(path: &Path) -> io::Result<Option<PathBuf>> {
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match existing.canonicalize() {
            Ok(mut resolved) => {
                for name in missing.into_iter().rev() {
                    resolved.push(name);
                }
                return Ok(Some(resolved));
            }
            // Instruction cleanup can remove a file or cyclic alias before
            // preparing a nested mount. Its future physical identity cannot be
            // established here; keep such layouts on the ordinary apply path.
            Err(error)
                if error.kind() == io::ErrorKind::NotADirectory
                    || error.raw_os_error() == Some(libc::ELOOP) =>
            {
                return Ok(None);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if std::fs::symlink_metadata(existing)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                {
                    return Ok(None);
                }
                missing.push(
                    existing
                        .file_name()
                        .ok_or_else(|| invalid("invalid runtime ancestor"))?,
                );
                existing = existing
                    .parent()
                    .ok_or_else(|| invalid("missing runtime ancestor"))?;
            }
            Err(error) => return Err(error),
        }
    }
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
            return Err(invalid("pending archive runtime overlaps an input"));
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
        let descriptor = manifest
            .archive_readiness
            .as_ref()
            .ok_or_else(|| invalid("missing archive readiness descriptor"))?;
        descriptor.validate(manifest).map_err(invalid)?;
        if !cfg!(target_os = "linux") {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "archive readiness requires Linux",
            ));
        }
        let runtime = runtime
            .filter(|path| path.is_absolute() && normalize_path(path) == *path)
            .ok_or_else(|| invalid("pending archives require a private absolute runtime"))?;
        let physical_runtime = physical_path(runtime)?
            .ok_or_else(|| invalid("private runtime has an unresolved alias"))?;
        for target in manifest
            .storages
            .iter()
            .map(|entry| PathBuf::from(&entry.mount_path))
            .chain(
                manifest
                    .artifacts
                    .iter()
                    .map(|entry| PathBuf::from(&entry.mount_path)),
            )
            .chain(manifest.cleanup_paths.iter().map(PathBuf::from))
            .chain(manifest.instruction_cleanups.iter().filter_map(|entry| {
                entry
                    .target_filename
                    .as_ref()
                    .map(|name| Path::new(&entry.mount_path).join(name))
            }))
        {
            let logical_target = normalize_path(&target);
            // Canonicalize the original path: collapsing symlink/.. first can
            // hide its actual destination inside the private runtime.
            if !logical_target.is_absolute() || overlaps(&logical_target, runtime) {
                return Ok(false);
            }
            let physical_target = match physical_path(&target) {
                // Cleanup can unlink an alias without traversing its old
                // destination. Do not require access to that destination just
                // to decide whether the ordinary apply path should be used.
                Err(error)
                    if error.kind() == io::ErrorKind::PermissionDenied
                        && has_cleanup_ancestor(manifest, &logical_target) =>
                {
                    return Ok(false);
                }
                result => result?,
            };
            let Some(physical_target) = physical_target else {
                // Ordinary application can replace a dangling alias. Do not
                // activate readiness when its physical destination is unknown.
                return Ok(false);
            };
            if overlaps(&physical_target, &physical_runtime) {
                return Ok(false);
            }
        }
        Ok(true)
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
