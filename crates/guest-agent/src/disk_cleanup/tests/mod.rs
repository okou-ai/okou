use super::*;

#[test]
fn cache_open_refuses_a_nested_filesystem() {
    let root = Dir::open_absolute(Path::new("/")).unwrap();
    let error = open_cache(&root, &["proc"])
        .err()
        .expect("nested mount must be refused");
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
}
