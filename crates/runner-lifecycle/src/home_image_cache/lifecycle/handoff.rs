use super::*;

impl HomeImageLease {
    /// Accept the selected seed immediately before factory creation. A rejected
    /// handoff is explicit so callers must rebuild image-derived preparation.
    /// Once accepted, the blocking task owns the guards through physical unlink,
    /// even if this future and its lease disappear. Shutdown joins that work.
    pub async fn home_drive_config(&mut self) -> LifecycleResult<Option<sandbox::HomeDriveConfig>> {
        if self.is_cache_hit() && !self.consumed_cache_hit {
            let commit = self.selected_commit_pin.take().ok_or_else(|| {
                LifecycleError::Internal("home seed handoff already attempted".into())
            })?;
            let entry = self.entry_lock.take().ok_or_else(|| {
                LifecycleError::Internal("home seed handoff requires entry ownership".into())
            })?;
            let pin = self.source_pin.take().ok_or_else(|| {
                LifecycleError::Internal("home seed handoff requires source pin".into())
            })?;
            let source = self.source_image.clone().ok_or_else(|| {
                LifecycleError::Internal("home seed handoff requires source".into())
            })?;
            let metadata = self.cache.home_image_cache_metadata(&entry.cache_key);
            #[cfg(any(test, feature = "test-support"))]
            let gate = self.cache.handoff_test_gate.clone();
            let (entry, pin, result) = self
                .cache
                .inner
                .checkout_io
                .spawn_blocking(move || {
                    #[cfg(any(test, feature = "test-support"))]
                    if let Some(gate) = gate {
                        gate.enter_and_wait();
                    }
                    let result: LifecycleResult<()> = (|| {
                        pin.validate_path(&source)?;
                        commit.validate_path(&metadata)?;
                        std::fs::remove_file(&metadata).map_err(|error| {
                            super::super::io_context::with_path(error, "revoke_commit", &metadata)
                        })?;
                        entry
                            .unused_selection
                            .store(false, std::sync::atomic::Ordering::Relaxed);
                        Ok(())
                    })();
                    (entry, pin, result)
                })
                .await
                .map_err(|error| {
                    LifecycleError::Internal(format!("home seed handoff task failed: {error}"))
                })?;
            self.entry_lock = Some(entry);
            self.source_pin = Some(pin);
            result?;
            self.consumed_cache_hit = true;
        }
        if let Some(source) = &self.source_image {
            let pin = self.source_pin.as_ref().ok_or_else(|| {
                LifecycleError::Internal("home seed requires pinned source".into())
            })?;
            pin.validate_path(source)?;
        }
        Ok(self.home_drive_enabled.then(|| sandbox::HomeDriveConfig {
            size_mb: home_image_size_mb(self.image_size_bytes),
            space_reserve: super::super::HOME_IMAGE_SPACE_RESERVE,
            seed_image: self.source_image.as_ref().map(|source| {
                if self.consumed_cache_hit {
                    sandbox::HomeDriveSeedImage::Move(source.clone())
                } else {
                    sandbox::HomeDriveSeedImage::Copy(source.clone())
                }
            }),
        }))
    }
}

impl HomeImageCache {
    /// Join accepted seed handoff, publication and explicit collection IO after
    /// producers/executor jobs settle, before dependent factory teardown.
    pub async fn drain_checkout_handoffs(&self) {
        self.inner.checkout_io.close();
        self.inner.checkout_io.wait().await;
    }
}
