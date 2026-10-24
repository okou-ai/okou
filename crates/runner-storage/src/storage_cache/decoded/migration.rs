//! Temporary bounded discovery of cold and hot persisted v1 entries (#42702).

use super::*;
use std::fs::{self, File, ReadDir};
use std::os::fd::AsRawFd;
use std::sync::Weak;
use std::time::Duration;
use tracing::{info, warn};

const SCAN_BATCH: usize = 64;
const BATCH_PAUSE: Duration = Duration::from_millis(250);
const RESCAN_PAUSE: Duration = Duration::from_secs(60);

struct Directory {
    file: File,
    entries: ReadDir,
}

impl Directory {
    fn new(file: File) -> io::Result<Self> {
        // Keep directory iteration anchored to the no-follow opened descriptor.
        let entries = fs::read_dir(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        Ok(Self { file, entries })
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Report {
    scanned: u64,
    converted: u64,
    remaining: u64,
    failed: u64,
    scan_errors: u64,
}

#[derive(Default)]
struct Cursor {
    names: Option<Directory>,
    versions: Option<Directory>,
    name_hash: String,
    report: Report,
}

fn is_hash(value: &str) -> bool {
    value.len() == 16 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl Cursor {
    /// At most 64 directory steps and one bounded payload operation per batch.
    /// The bool means enumeration ended; errors/remaining still prevent a zero
    /// inventory claim. Later full passes revisit busy keys and old late fills.
    fn batch(&mut self, home: &HomePaths, cancel: &CancellationToken) -> io::Result<bool> {
        if self.names.is_none() {
            match disk::open_directory(&home.storages_dir()).and_then(Directory::new) {
                Ok(names) => self.names = Some(names),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
                Err(error) => return Err(error),
            }
        }
        for _ in 0..SCAN_BATCH {
            if cancel.is_cancelled() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "migration cancelled",
                ));
            }
            if let Some(versions) = &mut self.versions {
                let entry = match versions.entries.next() {
                    Some(Ok(entry)) => entry,
                    Some(Err(error)) => {
                        self.report.scan_errors += 1;
                        warn!(%error, "decoded migration version enumeration failed");
                        continue;
                    }
                    None => {
                        self.versions = None;
                        continue;
                    }
                };
                let name = entry.file_name();
                let Some(version_hash) = name
                    .to_str()
                    .and_then(|name| name.strip_prefix("decoded-v1-"))
                    .filter(|hash| is_hash(hash))
                else {
                    continue;
                };
                self.report.scanned += 1;
                match disk::migrate_legacy(home, &self.name_hash, version_hash, cancel) {
                    Ok(disk::MigrationOutcome::Converted) => self.report.converted += 1,
                    Ok(disk::MigrationOutcome::Gone) => {}
                    Ok(disk::MigrationOutcome::Busy) => self.report.remaining += 1,
                    Err(error) if cancel.is_cancelled() => return Err(error),
                    Err(error) => {
                        self.report.remaining += 1;
                        self.report.failed += 1;
                        warn!(%error, name_hash = %self.name_hash, %version_hash,
                            "decoded migration entry unfinished");
                    }
                }
                return Ok(false);
            }
            let names = self
                .names
                .as_mut()
                .ok_or_else(|| io::Error::other("migration root cursor missing"))?;
            let entry = match names.entries.next() {
                Some(Ok(entry)) => entry,
                Some(Err(error)) => {
                    self.report.scan_errors += 1;
                    warn!(%error, "decoded migration name enumeration failed");
                    continue;
                }
                None => return Ok(true),
            };
            let name = entry.file_name();
            let Some(name_hash) = name.to_str().filter(|hash| is_hash(hash)) else {
                continue;
            };
            match disk::open_child_directory(&names.file, name_hash).and_then(Directory::new) {
                Ok(versions) => {
                    self.name_hash = name_hash.to_owned();
                    self.versions = Some(versions);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    self.report.scan_errors += 1;
                    warn!(%error, %name_hash, "decoded migration name scan incomplete");
                }
            }
        }
        Ok(false)
    }
}

pub(super) async fn run(owner: Weak<Inner>, cancel: CancellationToken) {
    let cursor = Arc::new(Mutex::new(Cursor::default()));
    let mut pause = BATCH_PAUSE;
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            () = tokio::time::sleep(pause) => {}
        }
        let Some(inner) = owner.upgrade() else { break };
        let cache = DecodedCache(inner);
        pause = BATCH_PAUSE;
        // Leave an optional blocking slot for ordinary cache consumers. The
        // actual worker/memory reservation is still made atomically by work().
        if cache.0.workers.available_permits() < 2 {
            continue;
        }
        let next = Arc::clone(&cursor);
        let result = cache
            .work(move |inner, _memory| {
                let mut cursor = next
                    .lock()
                    .map_err(|_| io::Error::other("migration cursor poisoned"))?;
                let finished = cursor.batch(&inner.home, &inner.cancel)?;
                let report = cursor.report;
                if finished {
                    *cursor = Cursor::default();
                }
                Ok((finished, report))
            })
            .await;
        match result {
            Ok(Some((true, report))) => {
                info!(
                    scanned = report.scanned,
                    converted = report.converted,
                    remaining_v1 = report.remaining,
                    failed = report.failed,
                    scan_errors = report.scan_errors,
                    scan_complete = report.scan_errors == 0,
                    "decoded cache migration pass completed"
                );
                pause = RESCAN_PAUSE;
            }
            Ok(_) => {}
            Err(_) if cancel.is_cancelled() => break,
            Err(error) => {
                warn!(%error, scan_complete = false, "decoded cache migration scan failed");
                *cursor.lock().unwrap_or_else(|e| e.into_inner()) = Cursor::default();
                pause = RESCAN_PAUSE;
            }
        }
    }
}

#[cfg(test)]
mod tests;
