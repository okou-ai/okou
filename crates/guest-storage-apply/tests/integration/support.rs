use cli_test_support::thread::join_until;
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::{Map, Value, json};
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tempfile::TempDir;

static RUN_ID_COUNTER: AtomicU64 = AtomicU64::new(0);
const TCP_SERVER_ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const TCP_SERVER_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const TCP_SERVER_JOIN_POLL_INTERVAL: Duration = Duration::from_millis(1);

pub(crate) struct TcpTestServerControl {
    listener: TcpListener,
    stop_rx: Receiver<()>,
}

impl TcpTestServerControl {
    pub(crate) fn accept(&self) -> io::Result<Option<TcpStream>> {
        loop {
            match self.stop_rx.try_recv() {
                Ok(()) | Err(mpsc::TryRecvError::Disconnected) => return Ok(None),
                Err(mpsc::TryRecvError::Empty) => {}
            }

            match self.listener.accept() {
                Ok((stream, _)) => return Ok(Some(stream)),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    match self.stop_rx.recv_timeout(TCP_SERVER_ACCEPT_POLL_INTERVAL) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub(crate) fn wait_for_shutdown(&self) {
        let _ = self.stop_rx.recv();
    }
}

pub(crate) struct TcpTestServer<T: Send + 'static> {
    base_url: String,
    stop_tx: Sender<()>,
    handle: Option<JoinHandle<io::Result<T>>>,
}

impl<T: Send + 'static> TcpTestServer<T> {
    pub(crate) fn start(
        serve: impl FnOnce(TcpTestServerControl) -> io::Result<T> + Send + 'static,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let base_url = format!("http://{}", listener.local_addr()?);
        let (stop_tx, stop_rx) = mpsc::channel();
        let handle = thread::spawn(move || serve(TcpTestServerControl { listener, stop_rx }));

        Ok(Self {
            base_url,
            stop_tx,
            handle: Some(handle),
        })
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn finish(mut self) -> io::Result<T> {
        self.shutdown()
    }

    fn shutdown(&mut self) -> io::Result<T> {
        let handle = self
            .handle
            .take()
            .ok_or_else(|| io::Error::other("TCP test server lost its thread"))?;
        let _ = self.stop_tx.send(());
        let deadline = Instant::now() + TCP_SERVER_CLEANUP_TIMEOUT;
        let joined = match join_until(handle, deadline, TCP_SERVER_JOIN_POLL_INTERVAL) {
            Some(joined) => joined,
            None => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("TCP test server did not stop within {TCP_SERVER_CLEANUP_TIMEOUT:?}"),
                ));
            }
        };

        joined.map_err(|_| io::Error::other("TCP test server panicked"))?
    }
}

impl<T: Send + 'static> Drop for TcpTestServer<T> {
    fn drop(&mut self) {
        if self.handle.is_some() {
            let _ = self.shutdown();
        }
    }
}

pub(crate) fn read_http_request_path(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 512];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let bytes_read = stream.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        request.extend(buffer.iter().take(bytes_read).copied());
    }

    let request = String::from_utf8_lossy(&request);
    Ok(request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default()
        .to_owned())
}

pub(crate) enum TarEntry<'a> {
    File(&'a str, &'a [u8]),
    Symlink(&'a str, &'a str),
    Hardlink(&'a str, &'a str),
    /// Hand-crafted entry for malicious-input tests that `tar::Builder`
    /// rejects (absolute paths, `..` components, empty linkname). Always
    /// written after all non-Raw entries in the archive.
    Raw {
        path: &'a [u8],
        /// Typeflag byte: `b'0'` regular file, `b'2'` symlink.
        entry_type: u8,
        /// Octal mode string like `b"0000644\0"`.
        mode: &'a [u8; 8],
        /// Empty = no data block appended (size stays zero).
        content: &'a [u8],
    },
}

/// Create a tar.gz archive in memory containing the given files.
pub(crate) fn create_tar_gz(files: &[(&str, &[u8])]) -> std::io::Result<Vec<u8>> {
    let entries: Vec<TarEntry> = files.iter().map(|(p, c)| TarEntry::File(p, c)).collect();
    create_tar_gz_entries(&entries)
}

/// Create a tar.gz archive with mixed file and symlink entries.
pub(crate) fn create_tar_gz_entries(entries: &[TarEntry]) -> std::io::Result<Vec<u8>> {
    /// Strip builder-written EOF, splice hand-crafted tar headers onto the
    /// end, and re-add EOF. Scoped as an inner fn so the indexing-slicing
    /// allow (needed because `allow-indexing-slicing-in-tests` only matches
    /// `#[test]` fns, not helper fns) stays off the rest of the helper.
    #[allow(clippy::indexing_slicing)]
    fn append_raw_entries(tar_data: &mut Vec<u8>, entries: &[TarEntry]) {
        while tar_data.len() >= 512 && tar_data[tar_data.len() - 512..].iter().all(|&b| b == 0) {
            tar_data.truncate(tar_data.len() - 512);
        }
        for entry in entries {
            if let TarEntry::Raw {
                path,
                entry_type,
                mode,
                content,
            } = entry
            {
                let mut header_block = [0u8; 512];
                header_block[..path.len()].copy_from_slice(path);
                header_block[100..108].copy_from_slice(*mode);
                header_block[108..116].copy_from_slice(b"0000000\0"); // uid
                header_block[116..124].copy_from_slice(b"0000000\0"); // gid
                let size_str = format!("{:011o}\0", content.len());
                header_block[124..136].copy_from_slice(size_str.as_bytes());
                header_block[136..148].copy_from_slice(b"00000000000\0"); // mtime
                header_block[156] = *entry_type;
                header_block[257..263].copy_from_slice(b"ustar\0");
                header_block[263..265].copy_from_slice(b"00");
                // Checksum: field filled with spaces, sum all bytes, write result.
                header_block[148..156].copy_from_slice(b"        ");
                let cksum: u32 = header_block.iter().map(|&b| b as u32).sum();
                let cksum_str = format!("{:06o}\0 ", cksum);
                header_block[148..156].copy_from_slice(cksum_str.as_bytes());

                tar_data.extend_from_slice(&header_block);
                if !content.is_empty() {
                    let mut data_block = [0u8; 512];
                    data_block[..content.len()].copy_from_slice(content);
                    tar_data.extend_from_slice(&data_block);
                }
            }
        }
        tar_data.extend_from_slice(&[0u8; 1024]); // EOF
    }

    let mut tar_data = Vec::new();
    let has_raw = entries.iter().any(|e| matches!(e, TarEntry::Raw { .. }));
    {
        let mut builder = tar::Builder::new(&mut tar_data);
        for entry in entries {
            match entry {
                TarEntry::File(path, contents) => {
                    let mut header = tar::Header::new_gnu();
                    header.set_size(contents.len() as u64);
                    header.set_mode(0o644);
                    header.set_cksum();
                    builder.append_data(&mut header, path, *contents)?;
                }
                TarEntry::Symlink(path, target) => {
                    let mut header = tar::Header::new_gnu();
                    header.set_size(0);
                    header.set_mode(0o777);
                    header.set_entry_type(tar::EntryType::Symlink);
                    header.set_cksum();
                    builder.append_link(&mut header, path, target)?;
                }
                TarEntry::Hardlink(path, target) => {
                    let mut header = tar::Header::new_gnu();
                    header.set_size(0);
                    header.set_mode(0o644);
                    header.set_entry_type(tar::EntryType::Link);
                    header.set_cksum();
                    builder.append_link(&mut header, path, target)?;
                }
                TarEntry::Raw { .. } => {} // appended after builder finishes
            }
        }
        builder.finish()?;
    }

    if has_raw {
        append_raw_entries(&mut tar_data, entries);
    }

    let mut gz_data = Vec::new();
    let mut encoder = GzEncoder::new(&mut gz_data, Compression::fast());
    encoder.write_all(&tar_data)?;
    encoder.finish()?;
    Ok(gz_data)
}

/// Write a manifest JSON to a temp file and return its path.
/// `storages`: list of (mount_path, archive_url) pairs.
/// `artifact`: optional (mount_path, archive_url) pair.
pub(crate) fn write_manifest(
    dir: &TempDir,
    storages: &[(&str, Option<&str>)],
    artifact: Option<(&str, Option<&str>)>,
) -> std::io::Result<PathBuf> {
    let json = manifest_json(storages, artifact)?;
    let manifest_path = dir.path().join("manifest.json");
    std::fs::write(&manifest_path, json)?;
    Ok(manifest_path)
}

pub(crate) fn manifest_json(
    storages: &[(&str, Option<&str>)],
    artifact: Option<(&str, Option<&str>)>,
) -> std::io::Result<Vec<u8>> {
    let mut manifest = Map::new();
    let mut storage_mounts: Vec<Value> = storages
        .iter()
        .map(|(mount_path, archive_url)| manifest_entry(mount_path, *archive_url, false))
        .collect();
    if let Some((mount_path, archive_url)) = artifact {
        storage_mounts.push(manifest_entry(mount_path, archive_url, true));
    }
    manifest.insert("storageMounts".to_owned(), Value::Array(storage_mounts));

    serde_json::to_vec(&Value::Object(manifest)).map_err(std::io::Error::other)
}

fn manifest_entry(mount_path: &str, archive_url: Option<&str>, writeback: bool) -> Value {
    let mut entry = Map::new();
    entry.insert("mountPath".to_owned(), json!(mount_path));
    entry.insert("writeback".to_owned(), json!(writeback));
    if let Some(url) = archive_url {
        entry.insert("archiveUrl".to_owned(), json!(url));
    }
    Value::Object(entry)
}

pub(crate) fn run_guest_storage_apply(manifest_path: &str) -> bool {
    guest_telemetry::log::clear_system_log_file();
    guest_storage_apply::run(manifest_path)
}

pub(crate) fn run_guest_storage_apply_manifest_json(manifest_json: &[u8]) -> bool {
    guest_telemetry::log::clear_system_log_file();
    guest_storage_apply::run_manifest_bytes(manifest_json)
}

pub(crate) fn assert_does_not_contain_any(haystack_name: &str, haystack: &str, forbidden: &[&str]) {
    for needle in forbidden {
        assert!(
            !haystack.contains(needle),
            "{haystack_name} should not contain {needle:?}: {haystack}"
        );
    }
}

pub(crate) fn unique_run_id(test_name: &str) -> String {
    format!(
        "guest-storage-apply-{test_name}-{}-{}",
        std::process::id(),
        RUN_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}
