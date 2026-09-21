use std::path::Path;

use crate::byte_size::human_bytes;

/// Return `(logical, disk)` as human-readable strings (e.g. "65.2 MiB").
///
/// `logical` is the apparent file size; `disk` is the actual disk usage
/// (from `st_blocks`), which can be much smaller for sparse files like rootfs.
pub(super) async fn file_sizes(path: &Path) -> (String, String) {
    use std::os::unix::fs::MetadataExt;
    match tokio::fs::metadata(path).await {
        Ok(m) => {
            const BYTES_PER_BLOCK: u64 = 512;
            let logical = human_bytes(m.len());
            let disk = human_bytes(m.blocks() * BYTES_PER_BLOCK);
            (logical, disk)
        }
        Err(_) => ("?".into(), "?".into()),
    }
}

runner_test_group!(cmd_gc_build; #[cfg(test)]
mod tests {
    use std::os::unix::fs::MetadataExt;

    use super::*;

    #[tokio::test]
    async fn file_sizes_reports_sparse_logical_and_disk_usage() {
        const LOGICAL_BYTES: u64 = 64 * 1024 * 1024;
        const BYTES_PER_BLOCK: u64 = 512;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.bin");
        tokio::fs::write(&path, [1_u8; 4096]).await.unwrap();
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .await
            .unwrap();
        file.set_len(LOGICAL_BYTES).await.unwrap();

        let metadata = tokio::fs::metadata(&path).await.unwrap();
        assert!(
            metadata.blocks() > 0,
            "sparse fixture must allocate at least one block"
        );
        let allocated_bytes = metadata.blocks() * BYTES_PER_BLOCK;
        assert!(
            allocated_bytes < metadata.len(),
            "sparse fixture must use fewer allocated bytes than its logical length"
        );

        let (logical, disk) = file_sizes(&path).await;
        assert_eq!(logical, human_bytes(metadata.len()));
        assert_eq!(disk, human_bytes(allocated_bytes));
    }

    #[tokio::test]
    async fn file_sizes_nonexistent_file() {
        let (logical, disk) = file_sizes(Path::new("/nonexistent/file.bin")).await;
        assert_eq!(logical, "?");
        assert_eq!(disk, "?");
    }
});
