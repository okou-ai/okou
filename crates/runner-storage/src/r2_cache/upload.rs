use std::path::Path;

use super::{R2Error, R2ImageCache, keys::key_for_template_hash, multipart::MultipartUploadGuard};

impl R2ImageCache {
    async fn exists_key(&self, key: &str) -> Result<bool, R2Error> {
        self.client.head(key).await
    }

    /// Pack one `template.ext4` member and stream-upload it under
    /// `runner-templates/`. `force` bypasses the HEAD deduplication check so a
    /// cache object rejected by the downloader can be atomically replaced.
    pub async fn upload_template(
        &self,
        hash: &str,
        rootfs: &Path,
        force: bool,
    ) -> Result<(), R2Error> {
        let key = key_for_template_hash(hash);
        self.upload_key(&key, rootfs, force).await
    }

    /// Returns `Ok(true)` if the shared template object exists.
    pub async fn template_exists(&self, hash: &str) -> Result<bool, R2Error> {
        let key = key_for_template_hash(hash);
        self.exists_key(&key).await
    }

    async fn upload_key(&self, key: &str, rootfs: &Path, force: bool) -> Result<(), R2Error> {
        if !force && self.exists_key(key).await? {
            tracing::info!("R2 already has {key}, skipping upload");
            return Ok(());
        }

        let upload_id = self.client.create_multipart(key).await?;
        let mut upload_guard = MultipartUploadGuard::new(
            self.client.clone(),
            self.bucket.clone(),
            key.to_string(),
            upload_id,
        );

        // Run the full pack→stream→complete pipeline, then abort if anything
        // failed (including Complete itself — server-side validation errors
        // can fail Complete after all parts uploaded successfully).
        let result = self
            .do_multipart_upload(key, upload_guard.upload_id(), rootfs)
            .await;
        if result.is_err() {
            // Best-effort abort; the guard remains armed if this await is
            // cancelled so Drop can still schedule a detached abort.
            upload_guard.abort().await;
        } else {
            upload_guard.disarm();
        }
        result
    }
}
