use super::*;

#[test]
fn payload_buckets_use_binary_framing_instead_of_manifest_json() {
    let files = [StorageFile {
        path: "private-name".to_string(),
        mode: 0o600,
        mtime: 1,
        content: vec![0; 8 * 1024],
    }];
    let groups = [("/private-mount", files.as_slice())];
    let input = files_input(b"{}".to_vec(), groups.to_vec())
        .unwrap()
        .into_input();
    assert_eq!(
        manifest_size_bucket(input.manifest_bytes()),
        "at_most_4_kib"
    );
    assert_eq!(input.payload_size_bucket(), "4_to_16_kib");
    assert_eq!(
        StorageInput::Json(vec![0; 64 * 1024]).payload_size_bucket(),
        "none"
    );
}

#[test]
fn binary_payload_buckets_keep_exact_bounded_encoding_ranges() {
    for (bound, at_bound, after_bound) in [
        (4 * 1024, "up_to_4_kib", "4_to_16_kib"),
        (16 * 1024, "4_to_16_kib", "16_to_64_kib"),
        (64 * 1024, "16_to_64_kib", "64_to_256_kib"),
        (256 * 1024, "64_to_256_kib", "256_kib_to_1_mib"),
        (1024 * 1024, "256_kib_to_1_mib", "1_to_4_mib"),
        (4 * 1024 * 1024, "1_to_4_mib", "4_to_15_mib"),
    ] {
        assert_eq!(binary_payload_size_bucket(bound), at_bound);
        assert_eq!(binary_payload_size_bucket(bound + 1), after_bound);
    }
    assert_eq!(
        binary_payload_size_bucket(storage_files::MAX_PAYLOAD_BYTES),
        "4_to_15_mib"
    );
}
