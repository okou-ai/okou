use super::move_noreplace;

#[test]
fn no_replace_moves_source_and_preserves_both_files_on_collision() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    let destination = dir.path().join("generation");
    std::fs::write(&source, b"committed generation").unwrap();
    move_noreplace(&source, &destination).unwrap();
    assert!(!source.exists());
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"committed generation"
    );

    std::fs::write(&source, b"next candidate").unwrap();
    let error = move_noreplace(&source, &destination).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EEXIST));
    assert_eq!(std::fs::read(&source).unwrap(), b"next candidate");
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"committed generation"
    );
}

#[test]
fn no_replace_rejects_a_dangling_symlink_without_replacing_it() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    let destination = dir.path().join("generation");
    std::fs::write(&source, b"candidate").unwrap();
    std::os::unix::fs::symlink("missing-target", &destination).unwrap();

    let error = move_noreplace(&source, &destination).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EEXIST));
    assert_eq!(std::fs::read(&source).unwrap(), b"candidate");
    assert_eq!(
        std::fs::read_link(&destination).unwrap(),
        std::path::Path::new("missing-target")
    );
}
