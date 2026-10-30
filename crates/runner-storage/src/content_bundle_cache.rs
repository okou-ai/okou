//! Hash-only immutable input cache, independent of Storage planning and identities.
use crate::{
    OBJECT_DOWNLOAD_TIMEOUT, ObjectDownloadRetryBudget, StorageError, StorageResult,
    object_download_http_retry_after, object_download_transient_transport_kind,
};
use runner_types::content_bundle::BundleReference;
use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
};
use tokio_util::sync::CancellationToken;

const MAX_BYTES: u64 = 32 * 1024 * 1024;
const CACHE_BYTES: u64 = 512 * 1024 * 1024;

struct PendingArchive(PathBuf);

impl Drop for PendingArchive {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.0)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, "content bundle temporary archive cleanup failed");
        }
    }
}

pub struct ContentBundleCache {
    root: PathBuf,
    http: reqwest::Client,
    downloads: Arc<Semaphore>,
}
impl ContentBundleCache {
    pub fn new(root: PathBuf) -> StorageResult<Self> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| StorageError::Config("Content bundle HTTP client failed".into()))?;
        Ok(Self {
            root,
            http,
            downloads: Arc::new(Semaphore::new(4)),
        })
    }
    /// Cancellation includes lock wait, attempts, and backoff. No signature-bearing errors escape.
    pub async fn get(
        &self,
        reference: &BundleReference,
        cancel: &CancellationToken,
    ) -> StorageResult<Vec<u8>> {
        reference.validate().map_err(StorageError::Config)?;
        let budget = ObjectDownloadRetryBudget::default();
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(StorageError::Cancelled),
            result = budget.run_attempt(self.get_owned(reference)) => result
                .map_err(|_| StorageError::Internal("Content bundle preparation budget expired".into()))?,
        }
    }
    async fn get_owned(&self, reference: &BundleReference) -> StorageResult<Vec<u8>> {
        fs::create_dir_all(&self.root).await?;
        fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700)).await?;
        let _lock =
            runner_host::lock::acquire(self.root.join(format!("{}.lock", reference.sha256)))
                .await?;
        let path = self.root.join(format!("{}.tar.gz", reference.sha256));
        match read_verified(&path, reference).await {
            Ok(Some(bytes)) => {
                runner_host::paths::touch_mtime(&path);
                tracing::info!(
                    sha256 = %reference.sha256,
                    archive_bytes = reference.archive_bytes,
                    cache_hit = true,
                    "content bundle cache lookup"
                );
                return Ok(bytes);
            }
            Ok(None) => {}
            Err(error) => return Err(error),
        }
        tracing::info!(
            sha256 = %reference.sha256,
            archive_bytes = reference.archive_bytes,
            cache_hit = false,
            "content bundle cache lookup"
        );
        let _permit = self
            .downloads
            .acquire()
            .await
            .map_err(|_| StorageError::Internal("Content bundle downloads stopped".into()))?;
        let temp = self.root.join(format!("{}.tmp", reference.sha256));
        // Release before the hash lock, including failed/cancelled transfers.
        let _pending = PendingArchive(temp.clone());
        let mut budget = ObjectDownloadRetryBudget::default();
        let mut attempt_number = 0u8;
        loop {
            attempt_number += 1;
            let started = Instant::now();
            let attempt = budget
                .run_attempt(self.download(reference, &temp))
                .await
                .map_err(|_| {
                    StorageError::Internal("Content bundle download budget expired".into())
                })?;
            let cause = attempt.as_ref().err().map(|(error, _)| error.to_string());
            tracing::info!(
                sha256 = %reference.sha256,
                attempt = attempt_number,
                duration_ms = started.elapsed().as_millis() as u64,
                success = attempt.is_ok(),
                cause,
                "content bundle download attempt"
            );
            match attempt {
                Ok(bytes) => {
                    fs::rename(&temp, &path).await?;
                    // Eviction is optional. A verified download remains usable if disk maintenance fails.
                    if let Err(error) = self.evict().await {
                        tracing::warn!(%error, "content bundle cache eviction failed");
                    }
                    return Ok(bytes);
                }
                Err((error, retry)) => {
                    let Some(retry) = budget.next_retry(retry) else {
                        return Err(error);
                    };
                    retry.wait().await.map_err(|_| {
                        StorageError::Internal("Content bundle retry budget expired".into())
                    })?;
                }
            }
        }
    }
    async fn download(
        &self,
        reference: &BundleReference,
        temp: &Path,
    ) -> Result<Vec<u8>, (StorageError, Option<Duration>)> {
        let terminal = |message: &str| (StorageError::Internal(message.into()), None);
        let transport = |error: reqwest::Error| {
            let retry = object_download_transient_transport_kind(&error).map(|_| Duration::ZERO);
            (
                StorageError::Internal(format!(
                    "Content bundle transfer failed ({})",
                    object_download_transient_transport_kind(&error).unwrap_or("transport")
                )),
                retry,
            )
        };
        let mut response = self
            .http
            .get(&reference.download_url)
            .timeout(OBJECT_DOWNLOAD_TIMEOUT)
            .send()
            .await
            .map_err(transport)?;
        if !response.status().is_success() {
            return Err((
                StorageError::Internal(format!(
                    "Content bundle HTTP {}",
                    response.status().as_u16()
                )),
                object_download_http_retry_after(&response),
            ));
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(temp)
            .await
            .map_err(|e| (e.into(), None))?;
        let mut bytes = Vec::new();
        let mut digest = Sha256::new();
        while let Some(chunk) = response.chunk().await.map_err(transport)? {
            if chunk.len() as u64 > reference.archive_bytes.saturating_sub(bytes.len() as u64) {
                return Err(terminal("Content bundle exceeds declared size"));
            }
            digest.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| (e.into(), None))?;
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() as u64 != reference.archive_bytes
            || hex::encode(digest.finalize()) != reference.sha256
        {
            return Err(terminal("Content bundle integrity mismatch"));
        }
        file.sync_all().await.map_err(|e| (e.into(), None))?;
        Ok(bytes)
    }
    async fn evict(&self) -> StorageResult<()> {
        let mut entries = fs::read_dir(&self.root).await?;
        let mut candidates = Vec::new();
        let mut total = 0u64;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if !matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("gz" | "tmp")
            ) {
                continue;
            }
            let metadata = entry.metadata().await?;
            if !metadata.is_file() {
                continue;
            }
            total = total.saturating_add(metadata.len());
            candidates.push((metadata.modified()?, metadata.len(), path));
        }
        candidates.sort();
        let mut count = candidates.len();
        for (_, size, path) in candidates {
            if total <= CACHE_BYTES
                && count <= 1024
                && path.extension().and_then(|e| e.to_str()) != Some("tmp")
            {
                continue;
            }
            let Some(hash) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".tar.gz").or_else(|| n.strip_suffix(".tmp")))
            else {
                continue;
            };
            if let runner_host::lock::TryLock::Acquired(_guard) =
                runner_host::lock::try_acquire_or_busy(self.root.join(format!("{hash}.lock")))
                    .await?
            {
                match fs::remove_file(&path).await {
                    Ok(()) => {
                        total = total.saturating_sub(size);
                        count = count.saturating_sub(1);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(())
    }
}
async fn read_verified(path: &Path, reference: &BundleReference) -> StorageResult<Option<Vec<u8>>> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .await
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).await?;
    if bytes.len() as u64 == reference.archive_bytes
        && hex::encode(Sha256::digest(&bytes)) == reference.sha256
    {
        Ok(Some(bytes))
    } else {
        fs::remove_file(path).await?;
        Ok(None)
    }
}

#[cfg(test)]
mod tests;
