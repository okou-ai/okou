//! Persistent extracted files with bounded in-flight memory and worker ownership.

#[cfg(test)]
use bytes::Bytes;
use guest_contracts::storage_files::{self, StorageFile};
use runner_host::paths::HomePaths;
use std::io::{self, Read};
use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

mod disk;

const CAPACITY: usize = 64 * 1024 * 1024;
const MAX_COMPRESSED_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_ADMITTED_FILES: usize = 4096;
pub(super) const MAX_ADMITTED_STORAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ADMITTED_COMPRESSED_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_ADMITTED_PATH_BYTES: usize = 512 * 1024;
pub(super) const MAX_ADMITTED_INDEX_BYTES: usize = 1024 * 1024;
// 4 MiB source + 8 MiB content + 4 MiB bounded metadata/decoder allowance.
// The semaphore covers optional cache work, not total Runner process RSS.
const FILL_RESERVATION: u32 = 16 * 1024 * 1024;
const READ_AHEAD_BYTES: usize = 16 * 1024 * 1024;
// Preserve the original 128-key/32-file ready-read-ahead envelope for tiny files.
const READ_AHEAD_FILES: usize = 128 * 32;
// A bounded lookup window avoids repeatedly pausing archive delivery for misses.
pub(super) const LOOKUP_BATCH_SIZE: usize = 128;
// Retain the former 16-key worst-case string budget while batching typical keys.
const LOOKUP_KEY_BYTES: usize = 16 * 2 * 4096;
pub(super) const REJECTION_BATCH_SIZE: usize = 16;

#[derive(Debug)]
pub struct CachedFiles {
    pub files: Vec<StorageFile>,
    pub(crate) archive_retirement_candidate: bool,
    _memory: OwnedSemaphorePermit,
}

struct Inner {
    home: HomePaths,
    closed: Mutex<bool>,
    memory: Arc<Semaphore>,
    workers: Arc<Semaphore>,
    tasks: TaskTracker,
    cancel: CancellationToken,
}

#[derive(Clone)]
pub struct DecodedCache(Arc<Inner>);

impl DecodedCache {
    pub fn new(home: HomePaths) -> Self {
        Self(Arc::new(Inner {
            home,
            closed: Mutex::new(false),
            memory: Arc::new(Semaphore::new(CAPACITY)),
            workers: Arc::new(Semaphore::new(2)),
            tasks: TaskTracker::new(),
            cancel: CancellationToken::new(),
        }))
    }

    pub async fn shutdown(&self) {
        {
            let mut closed = self.0.closed.lock().unwrap_or_else(|e| e.into_inner());
            *closed = true;
            self.0.cancel.cancel();
            self.0.tasks.close();
        }
        self.0.tasks.wait().await;
    }

    // Optional cache work never queues behind its own memory/worker budget.
    // The token is registered under the shutdown lock, including blocking I/O.
    async fn work<T, F>(&self, work: F) -> io::Result<Option<T>>
    where
        T: Send + 'static,
        F: FnOnce(Arc<Inner>, OwnedSemaphorePermit) -> io::Result<T> + Send + 'static,
    {
        tokio::task::consume_budget().await;
        match self.try_work(work)? {
            Some(task) => task.await.map_err(io::Error::other)?.map(Some),
            None => Ok(None),
        }
    }

    fn try_work<T, F>(&self, work: F) -> io::Result<Option<tokio::task::JoinHandle<io::Result<T>>>>
    where
        T: Send + 'static,
        F: FnOnce(Arc<Inner>, OwnedSemaphorePermit) -> io::Result<T> + Send + 'static,
    {
        let (task, worker, memory) = {
            let closed = self
                .0
                .closed
                .lock()
                .map_err(|_| io::Error::other("decoded cache state poisoned"))?;
            if *closed {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "decoded cache stopped",
                ));
            }
            let Ok(worker) = Arc::clone(&self.0.workers).try_acquire_owned() else {
                return Ok(None);
            };
            let Ok(memory) = Arc::clone(&self.0.memory).try_acquire_many_owned(FILL_RESERVATION)
            else {
                return Ok(None);
            };
            (self.0.tasks.token(), worker, memory)
        };
        let inner = Arc::clone(&self.0);
        Ok(Some(tokio::task::spawn_blocking(move || {
            let (_task, _worker) = (task, worker);
            work(inner, memory)
        })))
    }

    /// Optional post-spawn classification, sharing the existing decoded budget.
    /// The caller owns the returned task through completion, including errors.
    pub(super) fn try_rejected_archives(
        &self,
        keys: Vec<(String, String)>,
    ) -> io::Result<Option<tokio::task::JoinHandle<io::Result<Vec<bool>>>>> {
        if keys.len() > REJECTION_BATCH_SIZE
            || keys
                .iter()
                .any(|(name, version)| name.len() > 4096 || version.len() > 4096)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "rejection batch too large",
            ));
        }
        self.try_work(move |inner, _memory| {
            keys.into_iter()
                .map(|(name, version)| {
                    disk::rejected_archive(&inner.home, &name, &version, &inner.cancel)
                })
                .collect()
        })
    }

    /// Read already extracted files, without opening or decoding their archive.
    /// Missing/busy/ineligible entries retain ordinary archive delivery.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn get_ready(
        &self,
        name: &str,
        version: &str,
    ) -> io::Result<Option<Arc<CachedFiles>>> {
        Ok(self
            .get_ready_batch(&[Some((name, version))])
            .await?
            .pop()
            .flatten())
    }

    /// Amortize blocking-task dispatch without retaining contents between runs.
    pub(crate) async fn get_ready_batch(
        &self,
        keys: &[Option<(&str, &str)>],
    ) -> io::Result<Vec<Option<Arc<CachedFiles>>>> {
        if keys.len() > LOOKUP_BATCH_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "decoded lookup batch too large",
            ));
        }
        let count = keys.len();
        let mut key_bytes = 0;
        let keys = keys
            .iter()
            .map(|key| {
                key.filter(|(name, version)| name.len() <= 4096 && version.len() <= 4096)
                    .filter(|(name, version)| {
                        let bytes = name.len() + version.len();
                        if key_bytes + bytes > LOOKUP_KEY_BYTES {
                            return false;
                        }
                        key_bytes += bytes;
                        true
                    })
                    .map(|(name, version)| (name.to_owned(), version.to_owned()))
            })
            .collect::<Vec<_>>();
        if keys.iter().all(Option::is_none) {
            return Ok(vec![None; count]);
        }
        let result = self
            .work(move |inner, memory| {
                let mut first_memory = Some(memory);
                let mut result = Vec::with_capacity(keys.len());
                let mut ready_bytes = 0;
                let mut ready_files = 0;
                for key in keys {
                    let Some((name, version)) = key else {
                        result.push(None);
                        continue;
                    };
                    // Keep the existing payload stop. Check remaining file capacity
                    // only after metadata validation, even when its budget is full.
                    if ready_bytes >= storage_files::MAX_PAYLOAD_BYTES {
                        result.push(None);
                        continue;
                    }
                    let memory = first_memory.take().or_else(|| {
                        Arc::clone(&inner.memory)
                            .try_acquire_many_owned(FILL_RESERVATION)
                            .ok()
                    });
                    let Some(memory) = memory else {
                        result.push(None);
                        continue;
                    };
                    let files = disk::read_with_budget(
                        &inner.home,
                        &name,
                        &version,
                        READ_AHEAD_BYTES - ready_bytes,
                        READ_AHEAD_FILES - ready_files,
                        &inner.cancel,
                    )?;
                    if let Some(files) = &files {
                        ready_bytes += files.iter().map(|file| file.content.len()).sum::<usize>();
                        ready_files += files.len();
                    }
                    result.push(files.map(|files| {
                        // Only a scheduling hint, not authority to delete. An
                        // absent archive must not repeatedly consume the bounded
                        // background queue. Errors are handled by retirement,
                        // not allowed to break a valid extracted-file delivery.
                        let archive = inner
                            .home
                            .storage_cache_dir(&name, &version)
                            .join("archive.tar.gz");
                        let candidate = !matches!(std::fs::symlink_metadata(archive),
                            Err(error) if error.kind() == io::ErrorKind::NotFound);
                        cached_files(files, memory, candidate)
                    }));
                }
                Ok(result)
            })
            .await?;
        Ok(result.unwrap_or_else(|| vec![None; count]))
    }

    /// Called only by the existing post-spawn background-fill owner.
    pub async fn warm_from_archive(&self, name: &str, version: &str) -> io::Result<()> {
        if name.len() > 4096 || version.len() > 4096 {
            return Ok(());
        }
        let (name, version) = (name.to_owned(), version.to_owned());
        self.work(move |inner, _memory| {
            use std::fs::OpenOptions;
            use std::os::unix::fs::OpenOptionsExt;
            if disk::read(&inner.home, &name, &version, &inner.cancel)?.is_some()
                || disk::is_rejected(&inner.home, &name, &version, &inner.cancel)?
            {
                return Ok(());
            }
            let source_lock = match runner_host::lock::try_acquire_existing_or_missing_blocking(
                &inner.home.storage_lock(&name, &version),
            )
            .map_err(io::Error::other)?
            {
                runner_host::lock::ExistingTryLock::Acquired(lock) => lock,
                runner_host::lock::ExistingTryLock::Busy
                | runner_host::lock::ExistingTryLock::Missing => {
                    return Ok(());
                }
            };
            let path = inner
                .home
                .storage_cache_dir(&name, &version)
                .join("archive.tar.gz");
            let mut source = match OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
                .open(path)
            {
                Ok(source) => source,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error),
            };
            let metadata = source.metadata()?;
            if !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "storage archive is not a file",
                ));
            }
            if metadata.len() == 0 || metadata.len() > MAX_ADMITTED_COMPRESSED_BYTES as u64 {
                return Ok(());
            }
            let mut bytes = vec![0; metadata.len() as usize];
            source.read_exact(&mut bytes)?;
            if source.read(&mut [0])? != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "storage archive changed during read",
                ));
            }
            drop(source);
            drop(source_lock);
            let files = decode(&bytes, &inner.cancel)?;
            disk::publish(
                &inner.home,
                &name,
                &version,
                bytes.len(),
                files.as_deref(),
                &inner.cancel,
            )
        })
        .await?;
        Ok(())
    }

    /// Optional post-spawn cleanup after the current plan used extracted files.
    /// Unlike warming, this never downloads or recreates the compressed source.
    pub(crate) async fn retire_archive(&self, name: &str, version: &str) -> io::Result<bool> {
        if name.len() > 4096 || version.len() > 4096 {
            return Ok(false);
        }
        let (name, version) = (name.to_owned(), version.to_owned());
        Ok(self
            .work(move |inner, _memory| {
                disk::retire_archive(&inner.home, &name, &version, &inner.cancel)
            })
            .await?
            .unwrap_or(false))
    }

    #[cfg(test)]
    async fn resolve(
        &self,
        name: &str,
        version: &str,
        bytes: Bytes,
    ) -> io::Result<Option<Arc<CachedFiles>>> {
        if name.len() > 4096 || version.len() > 4096 || bytes.len() > MAX_ADMITTED_COMPRESSED_BYTES
        {
            return Ok(None);
        }
        let (name, version) = (name.to_owned(), version.to_owned());
        self.work(move |inner, memory| {
            let files = decode(&bytes, &inner.cancel)?;
            disk::publish(
                &inner.home,
                &name,
                &version,
                bytes.len(),
                files.as_deref(),
                &inner.cancel,
            )?;
            Ok(files.map(|files| cached_files(files, memory, false)))
        })
        .await
        .map(Option::flatten)
    }
}

fn cached_files(
    files: Vec<StorageFile>,
    mut memory: OwnedSemaphorePermit,
    archive_retirement_candidate: bool,
) -> Arc<CachedFiles> {
    let charged = files.capacity() * std::mem::size_of::<StorageFile>()
        + files
            .iter()
            .map(|file| file.path.capacity() + file.content.capacity())
            .sum::<usize>()
        + 256;
    if let Some(excess) = memory.split(memory.num_permits().saturating_sub(charged)) {
        drop(excess);
    }
    Arc::new(CachedFiles {
        files,
        archive_retirement_candidate,
        _memory: memory,
    })
}

fn decode(bytes: &[u8], cancel: &CancellationToken) -> io::Result<Option<Vec<StorageFile>>> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let decoder = flate2::read::GzDecoder::new(bytes);
    // Retain the producer's stream envelope independently of reader capability.
    let mut archive = tar::Archive::new(decoder.take((2 * MAX_ADMITTED_STORAGE_BYTES + 1) as u64));
    let mut files = Vec::new();
    let mut expanded = 0usize;
    let mut path_bytes = 0usize;
    let mut long_name = None;
    for entry in archive.entries()?.raw(true) {
        if cancel.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "decoded fill cancelled",
            ));
        }
        let mut entry = entry?;
        if entry.header().entry_type().is_gnu_longname() {
            // Match Guest's locked tar parser before interpreting extension data.
            let header = entry.header();
            if header.as_gnu().is_none() && header.as_ustar().is_none() {
                return Ok(None);
            }
            let size = entry.size();
            if long_name.is_some() || size == 0 || size > (storage_files::MAX_PATH_BYTES + 1) as u64
            {
                return Ok(None);
            }
            let mut name = vec![0; size as usize];
            entry.read_exact(&mut name)?;
            if name.pop() != Some(0) || name.is_empty() || name.contains(&0) {
                return Ok(None);
            }
            let Ok(name) = String::from_utf8(name) else {
                return Ok(None);
            };
            long_name = Some(name);
            continue;
        }
        if !entry.header().entry_type().is_file() || files.len() >= MAX_ADMITTED_FILES {
            return Ok(None);
        }
        let size = entry.size();
        if size > storage_files::MAX_FILE_BYTES as u64 {
            return Ok(None);
        }
        expanded += size as usize;
        if expanded > MAX_ADMITTED_STORAGE_BYTES || expanded > bytes.len().saturating_mul(4) {
            return Ok(None);
        }
        let path = match long_name.take() {
            Some(path) => path,
            None => {
                let Some(path) = entry.path()?.to_str().map(str::to_owned) else {
                    return Ok(None);
                };
                path
            }
        };
        path_bytes = path_bytes
            .checked_add(path.len())
            .ok_or_else(|| io::Error::other("decoded path size overflow"))?;
        if path_bytes > MAX_ADMITTED_PATH_BYTES {
            return Ok(None);
        }
        let mode = entry.header().mode()?;
        let mtime = entry.header().mtime()?;
        let mut content = vec![0; size as usize];
        entry.read_exact(&mut content)?;
        files.push(StorageFile {
            path,
            mode,
            mtime,
            content,
        });
    }
    if long_name.is_some() {
        return Ok(None);
    }
    // Tar ends before gzip necessarily validates its CRC and size trailer.
    // Finish the same bounded reader before any decoded files can be cached.
    let mut reader = archive.into_inner();
    let mut buffer = [0; 8192];
    loop {
        if cancel.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "decoded fill cancelled",
            ));
        }
        if reader.read(&mut buffer)? == 0 {
            break;
        }
    }
    if reader.limit() == 0 {
        // Reaching Take's limit is not proof of a validated gzip EOF. This
        // archive remains on the ordinary path, as with other ineligible input.
        return Ok(None);
    }
    if storage_files::validate_files(&files).is_err() || !disk::admitted_paths(&files) {
        return Ok(None);
    }
    Ok(Some(files))
}

#[cfg(test)]
mod tests;
