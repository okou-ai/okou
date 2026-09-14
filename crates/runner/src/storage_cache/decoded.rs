//! Process-owned decoded files. Active references retain their byte reservation.

use bytes::Bytes;
use guest_contracts::storage_files::{self, StorageFile};
use std::collections::HashMap;
use std::io::{self, Read};
use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const CAPACITY: usize = 64 * 1024 * 1024;
const ENTRY_LIMIT: usize = 1024;
// Covers input, output, tar/decoder buffers and bounded metadata during a fill.
const FILL_RESERVATION: u32 = 3 * 1024 * 1024;
// At most 64 KiB admitted content plus bounded tar headers. Avoid a blocking-pool
// round trip for tiny in-memory work; larger inputs still use that pool.
const INLINE_INPUT_LIMIT: usize = 16 * 1024;

#[derive(Debug)]
pub(crate) struct CachedFiles {
    pub(crate) files: Vec<StorageFile>,
    _memory: OwnedSemaphorePermit,
}

type FillResult = Result<Option<Arc<CachedFiles>>, String>;
enum Entry {
    Filling(watch::Receiver<Option<FillResult>>),
    Ready(Option<Arc<CachedFiles>>),
}

struct CacheEntry {
    value: Entry,
    _key_memory: OwnedSemaphorePermit,
}

struct State {
    entries: HashMap<(String, String), CacheEntry>,
    closed: bool,
}

struct Inner {
    state: Mutex<State>,
    memory: Arc<Semaphore>,
    workers: Arc<Semaphore>,
    tasks: TaskTracker,
    cancel: CancellationToken,
}

#[derive(Clone)]
pub(crate) struct DecodedCache(Arc<Inner>);

impl DecodedCache {
    pub(crate) fn new() -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State {
                entries: HashMap::new(),
                closed: false,
            }),
            memory: Arc::new(Semaphore::new(CAPACITY)),
            workers: Arc::new(Semaphore::new(2)),
            tasks: TaskTracker::new(),
            cancel: CancellationToken::new(),
        }))
    }

    pub(crate) async fn shutdown(&self) {
        {
            // Cleanup must still close and join owned workers if state is poisoned.
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.closed = true;
            state.entries.clear();
            self.0.cancel.cancel();
            self.0.tasks.close();
        }
        self.0.tasks.wait().await;
    }

    /// Pin an already decoded identity without opening its compressed disk cache.
    /// Missing, ineligible and in-flight entries still use the ordinary archive path.
    pub(crate) async fn get_ready(
        &self,
        name: &str,
        version: &str,
    ) -> io::Result<Option<Arc<CachedFiles>>> {
        if name.len() > 4096 || version.len() > 4096 {
            return Ok(None);
        }
        tokio::task::consume_budget().await;
        let state = self
            .0
            .state
            .lock()
            .map_err(|_| io::Error::other("decoded cache state poisoned"))?;
        if state.closed {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "decoded cache stopped",
            ));
        }
        match state
            .entries
            .get(&(name.to_owned(), version.to_owned()))
            .map(|entry| &entry.value)
        {
            Some(Entry::Ready(files)) => Ok(files.clone()),
            Some(Entry::Filling(_)) | None => Ok(None),
        }
    }

    pub(crate) async fn resolve(
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
        let inline = bytes.len() <= INLINE_INPUT_LIMIT;
        if inline {
            // Charge each lookup to the caller's cooperative scheduling budget.
            // Yield before installing a fill so cancellation cannot strand it.
            tokio::task::consume_budget().await;
        }
        let key = (name.to_owned(), version.to_owned());
        let mut inline_fill = None;
        let mut receiver = {
            let mut state = self
                .0
                .state
                .lock()
                .map_err(|_| io::Error::other("decoded cache state poisoned"))?;
            if state.closed {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "decoded cache stopped",
                ));
            }
            match state.entries.get(&key).map(|entry| &entry.value) {
                Some(Entry::Ready(files)) => return Ok(files.clone()),
                Some(Entry::Filling(receiver)) => receiver.clone(),
                None => {
                    let Ok(worker) = Arc::clone(&self.0.workers).try_acquire_owned() else {
                        return Ok(None);
                    };
                    // Eviction does not release memory retained by active consumers.
                    while state.entries.len() >= ENTRY_LIMIT
                        || self.0.memory.available_permits() < FILL_RESERVATION as usize
                    {
                        let victim =
                            state
                                .entries
                                .iter()
                                .find_map(|(key, entry)| match &entry.value {
                                    Entry::Ready(None) => Some(key.clone()),
                                    Entry::Ready(Some(files)) if Arc::strong_count(files) == 1 => {
                                        Some(key.clone())
                                    }
                                    _ => None,
                                });
                        let Some(victim) = victim else {
                            return Ok(None);
                        };
                        state.entries.remove(&victim);
                    }
                    let Ok(mut memory) =
                        Arc::clone(&self.0.memory).try_acquire_many_owned(FILL_RESERVATION)
                    else {
                        return Ok(None);
                    };
                    let (sender, receiver) = watch::channel(None);
                    let key_memory = memory
                        .split(1024 + 2 * (key.0.capacity() + key.1.capacity()))
                        .ok_or_else(|| {
                            io::Error::other("decoded key reservation exceeds fill budget")
                        })?;
                    state.entries.insert(
                        key.clone(),
                        CacheEntry {
                            value: Entry::Filling(receiver.clone()),
                            _key_memory: key_memory,
                        },
                    );
                    let inner = Arc::clone(&self.0);
                    // Track both execution modes before releasing the state lock:
                    // shutdown must join an inline fill running on another thread too.
                    let task = self.0.tasks.token();
                    let fill = move || {
                        let _task = task;
                        let _worker = worker;
                        let decoded = decode(&bytes, &inner.cancel);
                        drop(bytes);
                        let result = decoded
                            .map(|files| {
                                files.map(|files| {
                                    let charged = files.capacity()
                                        * std::mem::size_of::<StorageFile>()
                                        + files
                                            .iter()
                                            .map(|file| {
                                                file.path.capacity() + file.content.capacity()
                                            })
                                            .sum::<usize>()
                                        + 256;
                                    let mut memory = memory;
                                    if let Some(excess) =
                                        memory.split(memory.num_permits().saturating_sub(charged))
                                    {
                                        drop(excess);
                                    }
                                    Arc::new(CachedFiles {
                                        files,
                                        _memory: memory,
                                    })
                                })
                            })
                            .map_err(|error| error.to_string());
                        let Ok(mut state) = inner.state.lock() else {
                            sender.send_replace(Some(Err("decoded cache state poisoned".into())));
                            return;
                        };
                        if !state.closed {
                            match &result {
                                Ok(files) => {
                                    let Some(entry) = state.entries.get_mut(&key) else {
                                        sender.send_replace(Some(Err(
                                            "decoded fill lost its owned entry".into(),
                                        )));
                                        return;
                                    };
                                    entry.value = Entry::Ready(files.clone());
                                }
                                Err(_) => {
                                    state.entries.remove(&key);
                                }
                            }
                        }
                        sender.send_replace(Some(result));
                    };
                    if inline {
                        inline_fill = Some(fill);
                    } else {
                        tokio::task::spawn_blocking(fill);
                    }
                    receiver
                }
            }
        };
        if let Some(fill) = inline_fill {
            fill();
        }
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return result.map_err(io::Error::other);
            }
            receiver
                .changed()
                .await
                .map_err(|_| io::Error::other("decoded fill worker stopped"))?;
        }
    }
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
        let mut content = Vec::with_capacity(size as usize);
        entry.read_to_end(&mut content)?;
        if content.len() != size as usize {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "short archive entry",
            ));
        }
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
    if storage_files::validate_files(&files).is_err() {
        return Ok(None);
    }
    Ok(Some(files))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let cache = DecodedCache::new();
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
        let cache = DecodedCache::new();
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
        let cache = DecodedCache::new();
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
    async fn concurrent_fills_share_an_immutable_result_and_shutdown_closes_admission() {
        let cache = DecodedCache::new();
        let bytes = archive(&vec![b'a'; 200_000]);
        let (first, second) = tokio::join!(
            cache.resolve("name", "v1", bytes.clone()),
            cache.resolve("name", "v1", bytes.clone())
        );
        let first = first.unwrap().unwrap();
        let second = second.unwrap().unwrap();
        assert!(Arc::ptr_eq(&first, &second));
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
        let cache = DecodedCache::new();
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
        let cache = DecodedCache::new();
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
        let hit = cache.get_ready("pinned", "v1").await.unwrap().unwrap();
        assert!(Arc::ptr_eq(&pinned, &hit));
        drop(hit);
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
    async fn negative_entries_are_bounded_and_eviction_allows_new_identities() {
        let cache = DecodedCache::new();
        for index in 0..ENTRY_LIMIT + 1 {
            assert!(
                cache
                    .resolve(&format!("empty-{index}"), "v1", Bytes::new())
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(cache.0.state.lock().unwrap().entries.len(), ENTRY_LIMIT);
        assert!(
            cache
                .resolve("regular", "v1", archive(b"new"))
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(cache.0.state.lock().unwrap().entries.len(), ENTRY_LIMIT);
        cache.shutdown().await;
        assert_eq!(cache.0.memory.available_permits(), CAPACITY);
    }

    #[tokio::test]
    async fn busy_decoders_select_archive_without_queueing_more_work() {
        let cache = DecodedCache::new();
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
        assert!(cache.0.state.lock().unwrap().entries.is_empty());
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
        let cache = DecodedCache::new();
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
            assert!(completed.get() > 0);
            assert!(
                completed.get() < 4096,
                "cache lookup loop starved other ready work"
            );
        };
        tokio::join!(biased; lookups, peer);
        cache.shutdown().await;
    }
}
