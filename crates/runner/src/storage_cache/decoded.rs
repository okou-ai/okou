//! Persistent extracted files with bounded in-flight memory and worker ownership.

use crate::paths::HomePaths;
#[cfg(test)]
use bytes::Bytes;
use guest_contracts::storage_files::{self, StorageFile};
use std::io::{self, Read};
use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

mod disk;

const CAPACITY: usize = 64 * 1024 * 1024;
// Source, decoded files, bounded index/path metadata and decoder scratch.
const FILL_RESERVATION: u32 = 3 * 1024 * 1024;
// A bounded lookup window avoids repeatedly pausing archive delivery for misses.
pub(super) const LOOKUP_BATCH_SIZE: usize = 128;
// Retain the former 16-key worst-case string budget while batching typical keys.
const LOOKUP_KEY_BYTES: usize = 16 * 2 * 4096;

#[derive(Debug)]
pub(crate) struct CachedFiles {
    pub(crate) files: Vec<StorageFile>,
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
pub(crate) struct DecodedCache(Arc<Inner>);

impl DecodedCache {
    pub(crate) fn new(home: HomePaths) -> Self {
        Self(Arc::new(Inner {
            home,
            closed: Mutex::new(false),
            memory: Arc::new(Semaphore::new(CAPACITY)),
            workers: Arc::new(Semaphore::new(2)),
            tasks: TaskTracker::new(),
            cancel: CancellationToken::new(),
        }))
    }

    pub(crate) async fn shutdown(&self) {
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
        tokio::task::spawn_blocking(move || {
            let (_task, _worker) = (task, worker);
            work(inner, memory).map(Some)
        })
        .await
        .map_err(io::Error::other)?
    }

    /// Read already extracted files, without opening or decoding their archive.
    /// Missing/busy/ineligible entries retain ordinary archive delivery.
    pub(crate) async fn get_ready(
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
                for key in keys {
                    let Some((name, version)) = key else {
                        result.push(None);
                        continue;
                    };
                    // Widen miss probes without widening ready-file read-ahead.
                    // The final read adds at most one storage (1 MiB), keeping
                    // content below the former 16-key maximum of 16 MiB.
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
                    let files = disk::read(&inner.home, &name, &version, &inner.cancel)?.flatten();
                    if let Some(files) = &files {
                        ready_bytes += files.iter().map(|file| file.content.len()).sum::<usize>();
                    }
                    result.push(files.map(|files| cached_files(files, memory)));
                }
                Ok(result)
            })
            .await?;
        Ok(result.unwrap_or_else(|| vec![None; count]))
    }

    /// Called only by the existing post-spawn background-fill owner.
    pub(crate) async fn warm_from_archive(&self, name: &str, version: &str) -> io::Result<()> {
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
            let source_lock = match crate::lock::try_acquire_existing_or_missing_blocking(
                &inner.home.storage_lock(&name, &version),
            )
            .map_err(io::Error::other)?
            {
                crate::lock::ExistingTryLock::Acquired(lock) => lock,
                crate::lock::ExistingTryLock::Busy | crate::lock::ExistingTryLock::Missing => {
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
            if metadata.len() == 0 || metadata.len() > storage_files::MAX_STORAGE_BYTES as u64 {
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

    #[cfg(test)]
    async fn resolve(
        &self,
        name: &str,
        version: &str,
        bytes: Bytes,
    ) -> io::Result<Option<Arc<CachedFiles>>> {
        if name.len() > 4096
            || version.len() > 4096
            || bytes.len() > storage_files::MAX_STORAGE_BYTES
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
            Ok(files.map(|files| cached_files(files, memory)))
        })
        .await
        .map(Option::flatten)
    }
}

fn cached_files(files: Vec<StorageFile>, mut memory: OwnedSemaphorePermit) -> Arc<CachedFiles> {
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
        _memory: memory,
    })
}

fn decode(bytes: &[u8], cancel: &CancellationToken) -> io::Result<Option<Vec<StorageFile>>> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let decoder = flate2::read::GzDecoder::new(bytes);
    // Bound even ignored extension/header data, not just admitted file contents.
    let mut archive =
        tar::Archive::new(decoder.take((2 * storage_files::MAX_STORAGE_BYTES + 1) as u64));
    let mut files = Vec::new();
    let mut expanded = 0usize;
    for entry in archive.entries()?.raw(true) {
        if cancel.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "decoded fill cancelled",
            ));
        }
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() || files.len() >= storage_files::MAX_FILES {
            return Ok(None);
        }
        let size = entry.size();
        if size > storage_files::MAX_FILE_BYTES as u64 {
            return Ok(None);
        }
        expanded += size as usize;
        if expanded > storage_files::MAX_STORAGE_BYTES || expanded > bytes.len().saturating_mul(4) {
            return Ok(None);
        }
        let Some(path) = entry.path()?.to_str().map(str::to_owned) else {
            return Ok(None);
        };
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
mod tests {
    use super::*;

    #[tokio::test]
    async fn lookup_skips_unselected_and_oversized_identities_without_io() {
        let root = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(root.path().to_owned());
        let cache = DecodedCache::new(home.clone());
        cache
            .resolve("name", "v1", archive(b"hello"))
            .await
            .unwrap();
        let oversized = "x".repeat(4097);
        let ready = cache
            .get_ready_batch(&[
                None,
                Some((&oversized, "v1")),
                Some(("name", &oversized)),
                Some(("name", "v1")),
            ])
            .await
            .unwrap();
        assert_eq!(ready.len(), 4);
        assert!(ready[..3].iter().all(Option::is_none));
        assert_eq!(ready[3].as_ref().unwrap().files[0].content, b"hello");
        assert!(
            cache
                .get_ready_batch(&[None; LOOKUP_BATCH_SIZE + 1])
                .await
                .is_err()
        );
        let wide = cache
            .get_ready_batch(&[Some(("name", "v1")); LOOKUP_BATCH_SIZE])
            .await
            .unwrap();
        assert!(wide.iter().all(|files| {
            files
                .as_ref()
                .is_some_and(|files| files.files[0].content == b"hello")
        }));
        let long = "k".repeat(4096);
        let mut budget = vec![Some((long.as_str(), long.as_str())); 16];
        budget.push(Some(("name", "v1")));
        assert!(
            cache
                .get_ready_batch(&budget)
                .await
                .unwrap()
                .iter()
                .all(Option::is_none)
        );
        // A batch's key budget cannot make a later independent lookup miss.
        assert!(cache.get_ready("name", "v1").await.unwrap().is_some());
        // No selected identities need filesystem access or a worker.
        cache.shutdown().await;
        assert!(cache.get_ready_batch(&[None]).await.unwrap()[0].is_none());
    }

    #[tokio::test]
    async fn wide_lookup_bounds_ready_read_ahead_even_when_all_keys_hit() {
        let root = tempfile::tempdir().unwrap();
        let cache = DecodedCache::new(HomePaths::with_root(root.path().to_owned()));
        cache
            .resolve(
                "name",
                "v1",
                archive(&vec![42; storage_files::MAX_FILE_BYTES]),
            )
            .await
            .unwrap();
        let ready = cache
            .get_ready_batch(&[Some(("name", "v1")); LOOKUP_BATCH_SIZE])
            .await
            .unwrap();
        let admitted = storage_files::MAX_PAYLOAD_BYTES / storage_files::MAX_FILE_BYTES;
        assert!(ready[..admitted].iter().all(Option::is_some));
        assert!(ready[admitted..].iter().all(Option::is_none));
        let retained: usize = ready
            .iter()
            .flatten()
            .flat_map(|files| &files.files)
            .map(|file| file.content.len())
            .sum();
        assert_eq!(retained, storage_files::MAX_PAYLOAD_BYTES);
        drop(ready);
        assert!(cache.get_ready("name", "v1").await.unwrap().is_some());
        cache.shutdown().await;
    }

    #[tokio::test]
    async fn abandoned_caller_does_not_detach_blocking_work_from_shutdown() {
        let root = tempfile::tempdir().unwrap();
        let cache = DecodedCache::new(HomePaths::with_root(root.path().to_owned()));
        let (started, entered) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let operation_cache = cache.clone();
        let operation = tokio::spawn(async move {
            operation_cache
                .work(move |_, _memory| {
                    started.send(()).unwrap();
                    wait.recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    Ok(())
                })
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), entered)
            .await
            .unwrap()
            .unwrap();
        operation.abort();
        assert!(operation.await.unwrap_err().is_cancelled());
        let mut shutdown = Box::pin(cache.shutdown());
        assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
        assert!(cache.get_ready("any", "v1").await.is_err());
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), shutdown)
            .await
            .unwrap();
        assert_eq!(cache.0.memory.available_permits(), CAPACITY);
        assert_eq!(cache.0.workers.available_permits(), 2);
    }

    fn archive(content: &[u8]) -> Bytes {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_ustar();
        header.set_size(content.len() as u64);
        header.set_mode(0o751);
        header.set_mtime(1234);
        header.set_cksum();
        builder
            .append_data(&mut header, "nested/file", content)
            .unwrap();
        Bytes::from(builder.into_inner().unwrap().finish().unwrap())
    }

    #[tokio::test]
    async fn decoded_cache_rejects_invalid_gzip_trailers_after_tar_end() {
        use std::io::Write;

        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_ustar();
        header.set_size(7);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "file", &b"content"[..])
            .unwrap();
        let mut encoder = builder.into_inner().unwrap();
        // Tar finishes before gzip. Padding forces its trailer beyond reads
        // needed for the tar entries, matching the normal archive contract.
        encoder.write_all(&vec![0; 64 * 1024]).unwrap();
        let valid = encoder.finish().unwrap();
        let mut bad_crc = valid.clone();
        let trailer = bad_crc.len() - 8;
        bad_crc[trailer] ^= 1;
        let mut bad_size = valid.clone();
        bad_size[trailer + 4] ^= 1;
        let truncated = valid[..trailer].to_vec();
        let cache_root = tempfile::tempdir().unwrap();
        let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
        for (version, bytes) in [
            ("crc", bad_crc),
            ("size", bad_size),
            ("truncated", truncated),
        ] {
            assert!(
                cache
                    .resolve("integrity", version, Bytes::from(bytes))
                    .await
                    .is_err(),
                "decoded cache accepted invalid {version} trailer"
            );
            assert!(
                cache
                    .get_ready("integrity", version)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        let files = cache
            .resolve("integrity", "valid", Bytes::from(valid))
            .await
            .unwrap()
            .unwrap();
        let destination = tempfile::tempdir().unwrap();
        let mount = destination.path().to_str().unwrap();
        let manifest = serde_json::to_vec(&serde_json::json!({
            "storageMounts": [{"mountPath": mount, "archiveUrl": "file:///not-staged"}]
        }))
        .unwrap();
        let input = storage_files::encode_input(&manifest, &[(mount, &files.files)]).unwrap();
        assert!(guest_storage_apply::run_storage_files_bytes(&input));
        assert_eq!(
            std::fs::read(destination.path().join("file")).unwrap(),
            b"content"
        );
        cache.shutdown().await;
    }

    #[tokio::test]
    async fn decoded_cache_does_not_accept_reader_limit_as_valid_gzip_eof() {
        use std::io::Write;

        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_ustar();
        header.set_size(7);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "file", &b"content"[..])
            .unwrap();
        let mut encoder = builder.into_inner().unwrap();
        encoder
            .write_all(&vec![0; 2 * storage_files::MAX_STORAGE_BYTES])
            .unwrap();
        let cache_root = tempfile::tempdir().unwrap();
        let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
        assert!(
            cache
                .resolve("padding", "v1", Bytes::from(encoder.finish().unwrap()))
                .await
                .unwrap()
                .is_none()
        );
        assert!(cache.get_ready("padding", "v1").await.unwrap().is_none());
        cache.shutdown().await;
    }

    #[tokio::test]
    async fn cached_versions_materialize_the_selected_content() {
        let cache_root = tempfile::tempdir().unwrap();
        let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
        for (name, version, content) in [
            ("first", "v1", &b"one"[..]),
            ("other", "v1", &b"two"[..]),
            ("first", "v2", &b"three"[..]),
            ("first", "v1", &b"one"[..]),
        ] {
            let files = cache
                .resolve(name, version, archive(content))
                .await
                .unwrap()
                .unwrap();
            let root = tempfile::tempdir().unwrap();
            let mount = root.path().join("mount");
            let manifest = serde_json::to_vec(&serde_json::json!({"storageMounts":[{"mountPath":mount,"archiveUrl":"file:///not-staged"}]})).unwrap();
            let input =
                storage_files::encode_input(&manifest, &[(mount.to_str().unwrap(), &files.files)])
                    .unwrap();
            assert!(guest_storage_apply::run_storage_files_bytes(&input));
            assert_eq!(std::fs::read(mount.join("nested/file")).unwrap(), content);
        }
        cache.shutdown().await;
    }

    #[tokio::test]
    async fn concurrent_fills_publish_once_and_shutdown_closes_admission() {
        let cache_root = tempfile::tempdir().unwrap();
        let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
        let bytes = archive(&vec![b'a'; 200_000]);
        let (first, second) = tokio::join!(
            cache.resolve("name", "v1", bytes.clone()),
            cache.resolve("name", "v1", bytes.clone())
        );
        let first = first.unwrap().unwrap();
        let second = second.unwrap().unwrap();
        assert_eq!(first.files, second.files);
        let persisted = cache.get_ready("name", "v1").await.unwrap().unwrap();
        assert_eq!(persisted.files, first.files);
        cache.shutdown().await;
        assert!(cache.resolve("name", "v1", bytes).await.is_err());
        assert_eq!(
            cache.get_ready("name", "v1").await.unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
        assert_eq!(first.files[0].content.len(), 200_000);
    }

    #[tokio::test]
    async fn unsupported_shapes_are_not_ready_file_sets_and_corruption_is_an_error() {
        let cache_root = tempfile::tempdir().unwrap();
        let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        let mut builder = tar::Builder::new(&mut gzip);
        let mut header = tar::Header::new_ustar();
        header.set_size(200_000);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "file", &vec![0; 200_000][..])
            .unwrap();
        builder.finish().unwrap();
        drop(builder);
        let compressed = Bytes::from(gzip.finish().unwrap());
        assert!(
            cache
                .resolve("large-ratio", "v1", compressed)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            cache
                .resolve("corrupt", "v1", Bytes::from_static(b"bad"))
                .await
                .is_err()
        );
        assert!(
            cache
                .resolve("corrupt", "v1", archive(b"valid"))
                .await
                .unwrap()
                .is_some()
        );
        cache.shutdown().await;
    }

    #[tokio::test]
    async fn pinned_content_remains_charged_and_admission_resumes_after_release() {
        let cache_root = tempfile::tempdir().unwrap();
        let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
        let pinned = cache
            .resolve("pinned", "v1", archive(b"keep"))
            .await
            .unwrap()
            .unwrap();
        let pressure = Arc::clone(&cache.0.memory)
            .try_acquire_many_owned(cache.0.memory.available_permits() as u32)
            .unwrap();
        assert!(
            cache
                .resolve("next", "v1", archive(b"next"))
                .await
                .unwrap()
                .is_none()
        );
        assert!(cache.get_ready("pinned", "v1").await.unwrap().is_none());
        drop(pressure);
        let next = cache
            .resolve("next", "v1", archive(b"next"))
            .await
            .unwrap()
            .unwrap();
        cache.shutdown().await;
        assert!(cache.0.memory.available_permits() < CAPACITY);
        assert_eq!(pinned.files[0].content, b"keep");
        drop(next);
        drop(pinned);
        assert_eq!(cache.0.memory.available_permits(), CAPACITY);
    }

    #[tokio::test]
    async fn background_fill_reuses_persistent_rejection_without_decoding_again() {
        let root = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(root.path().to_owned());
        drop(
            crate::lock::acquire(home.storage_lock("name", "v1"))
                .await
                .unwrap(),
        );
        let source = home.storage_cache_dir("name", "v1").join("archive.tar.gz");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(
            &source,
            archive(&vec![1; storage_files::MAX_FILE_BYTES + 1]),
        )
        .unwrap();
        let cache = DecodedCache::new(home.clone());
        cache.warm_from_archive("name", "v1").await.unwrap();
        cache.shutdown().await;
        assert!(disk::is_rejected(&home, "name", "v1", &CancellationToken::new()).unwrap());
        std::fs::write(source, b"must not decode this source").unwrap();
        let cache = DecodedCache::new(home);
        cache.warm_from_archive("name", "v1").await.unwrap();
        assert!(cache.get_ready("name", "v1").await.unwrap().is_none());
        cache.shutdown().await;
    }

    #[tokio::test]
    async fn negative_admission_survives_restart_without_retaining_memory() {
        let cache_root = tempfile::tempdir().unwrap();
        let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
        for index in 0..4 {
            assert!(
                cache
                    .resolve(&format!("empty-{index}"), "v1", Bytes::new())
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        cache.shutdown().await;
        assert_eq!(cache.0.memory.available_permits(), CAPACITY);
        let home = HomePaths::with_root(cache_root.path().to_owned());
        for index in 0..4 {
            assert!(
                disk::is_rejected(
                    &home,
                    &format!("empty-{index}"),
                    "v1",
                    &CancellationToken::new()
                )
                .unwrap()
            );
        }
    }

    #[tokio::test]
    async fn busy_decoders_select_archive_without_queueing_more_work() {
        let cache_root = tempfile::tempdir().unwrap();
        let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
        let workers = Arc::clone(&cache.0.workers)
            .try_acquire_many_owned(2)
            .unwrap();
        assert!(
            cache
                .resolve("name", "v1", archive(b"data"))
                .await
                .unwrap()
                .is_none()
        );
        assert!(!disk::paths(&cache.0.home, "name", "v1").0.exists());
        assert_eq!(cache.0.memory.available_permits(), CAPACITY);
        drop(workers);
        assert!(
            cache
                .resolve("name", "v1", archive(b"data"))
                .await
                .unwrap()
                .is_some()
        );
        cache.shutdown().await;
    }

    #[test]
    fn cancelled_decode_does_not_return_a_ready_file_set() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            decode(&archive(b"data"), &cancel).unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn repeated_tiny_cache_lookups_allow_other_ready_work_to_progress() {
        let cache_root = tempfile::tempdir().unwrap();
        let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
        assert!(
            cache
                .resolve("empty", "v1", Bytes::new())
                .await
                .unwrap()
                .is_none()
        );
        let completed = std::cell::Cell::new(0);
        let lookups = async {
            for _ in 0..4096 {
                assert!(
                    cache
                        .resolve("empty", "v1", Bytes::new())
                        .await
                        .unwrap()
                        .is_none()
                );
                completed.set(completed.get() + 1);
            }
        };
        let peer = async {
            assert!(
                completed.get() < 4096,
                "cache lookup loop starved other ready work"
            );
        };
        tokio::join!(biased; lookups, peer);
        cache.shutdown().await;
    }
}
