//! Mutable staging authority is the exclusively created descriptor, even after a partial write.

use super::*;
use std::fs::File;
use std::os::unix::fs::{FileExt, OpenOptionsExt};
use std::sync::Arc;

pub(in crate::home_image_cache) struct StagingFile {
    file: Arc<File>,
}

impl StagingFile {
    pub(in crate::home_image_cache) fn create(path: &Path) -> LifecycleResult<Self> {
        runner_host::host_file::validate_dir(
            runner_host::host_file::file_parent(path),
            runner_host::host_file::DirMode::Private,
            "home publication staging parent",
        )?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(runner_host::host_file::PRIVATE_FILE_MODE)
            .custom_flags(runner_host::host_file::private_file_open_flags())
            .open(path)
            .map_err(|error| with_path(error, "create_publication_staging", path))?;
        runner_host::host_file::secure_regular_private_file(
            &file,
            path,
            "home publication staging",
        )?;
        let owned = Self {
            file: Arc::new(file),
        };
        owned.validate_path(path)?;
        Ok(owned)
    }

    pub(in crate::home_image_cache) fn validate_path(&self, path: &Path) -> LifecycleResult<()> {
        let descriptor = self
            .file
            .metadata()
            .map_err(|error| with_path(error, "File::metadata", path))?;
        let observed = std::fs::symlink_metadata(path)
            .map_err(|error| with_path(error, "symlink_metadata", path))?;
        if !descriptor.is_file()
            || !observed.is_file()
            || descriptor.nlink() != 1
            || observed.nlink() != 1
            || descriptor.dev() != observed.dev()
            || descriptor.ino() != observed.ino()
        {
            return Err(LifecycleError::Internal(
                "publication staging inode changed".into(),
            ));
        }
        secure_home_cache_publication_file(path)
    }

    pub(in crate::home_image_cache) fn descriptor(&self) -> &File {
        &self.file
    }

    pub(in crate::home_image_cache) async fn write_owned(
        &self,
        path: &Path,
        bytes: Vec<u8>,
    ) -> LifecycleResult<()> {
        self.validate_path(path)?;
        let file = self.file.clone();
        let destination = path.to_owned();
        tokio::task::spawn_blocking(move || {
            file.set_len(0)
                .map_err(|error| with_path(error, "truncate_publication_staging", &destination))?;
            file.write_all_at(&bytes, 0)
                .map_err(|error| with_path(error, "write_publication_staging", &destination))
        })
        .await
        .map_err(|error| {
            LifecycleError::Internal(format!("publication staging write task failed: {error}"))
        })??;
        self.validate_path(path)
    }

    pub(in crate::home_image_cache) async fn sync_owned(&self, path: &Path) -> LifecycleResult<()> {
        self.validate_path(path)?;
        super::sync_descriptor(&self.file, path, || {}).await?;
        self.validate_path(path)
    }
}
