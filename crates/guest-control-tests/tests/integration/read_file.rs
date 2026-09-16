use std::io;
use std::os::unix::fs::symlink;

use crate::support::Harness;

#[tokio::test]
async fn read_file_preserves_content_and_rejects_oversized_sources() {
    let h = Harness::new().await;
    let path = h.dir.join("session'one $(false);.txt");
    const LIMIT: usize = 65_536;

    for size in [0, 1, LIMIT - 1, LIMIT, LIMIT + 1, 8 << 20] {
        let content: Vec<u8> = (0..size).map(|index| (index % 256) as u8).collect();
        std::fs::write(&path, &content).unwrap();
        let result = h
            .host()
            .read_file(path.to_str().unwrap(), LIMIT as u64, 5000)
            .await;
        if size <= LIMIT {
            assert_eq!(result.unwrap(), Some(content));
        } else {
            let error = result.unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert!(error.to_string().contains("exceeded 65536 bytes"));
        }
    }
    // A completed read must release its normal-operation ownership.
    drop(h.host().try_fence_normal_operations().unwrap());
    h.finish();
}

#[tokio::test]
async fn read_file_preserves_regular_file_and_symlink_classification() {
    let h = Harness::new().await;
    let regular = h.dir.join("regular");
    std::fs::write(&regular, b"content").unwrap();
    let link = h.dir.join("link");
    symlink(&regular, &link).unwrap();
    assert_eq!(
        h.host()
            .read_file(link.to_str().unwrap(), 7, 5000)
            .await
            .unwrap(),
        Some(b"content".to_vec())
    );
    assert!(
        h.host()
            .read_file(link.to_str().unwrap(), 6, 5000)
            .await
            .is_err()
    );
    std::fs::remove_file(&regular).unwrap();
    let directory_link = h.dir.join("directory-link");
    symlink(&h.dir, &directory_link).unwrap();
    for path in [&regular, &link, &h.dir, &directory_link] {
        assert_eq!(
            h.host()
                .read_file(path.to_str().unwrap(), 1024, 5000)
                .await
                .unwrap(),
            None
        );
    }
    h.finish();
}

#[tokio::test]
async fn read_file_reports_genuine_read_failure_for_a_regular_file() {
    let h = Harness::new().await;
    // Linux exposes this as a regular file, but reading its unmapped address
    // zero fails with EIO even when the test runs as root.
    let error = h
        .host()
        .read_file("/proc/self/mem", 1024, 5000)
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Other);
    assert!(error.to_string().contains("failed to read file"));
    drop(h.host().try_fence_normal_operations().unwrap());
    h.finish();
}
