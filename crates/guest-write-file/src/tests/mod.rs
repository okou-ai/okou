use super::*;

#[test]
fn parse_create_parents() {
    let args = parse_args(["--create-parents".to_string(), "/tmp/out.txt".to_string()]).unwrap();

    assert_eq!(
        args,
        Args {
            append: false,
            batch: false,
            create_parents: true,
            private: false,
            path: Some(PathBuf::from("/tmp/out.txt")),
        }
    );
}

#[test]
fn parse_append_after_separator_path_starting_with_dash() {
    let args = parse_args([
        "--append".to_string(),
        "--".to_string(),
        "-literal".to_string(),
    ])
    .unwrap();

    assert_eq!(
        args,
        Args {
            append: true,
            batch: false,
            create_parents: false,
            private: false,
            path: Some(PathBuf::from("-literal")),
        }
    );
}

#[test]
fn rejects_extra_path() {
    let err = parse_args(["/tmp/a".to_string(), "/tmp/b".to_string()]).unwrap_err();

    assert!(err.contains("exactly one path"));
}

#[test]
fn rejects_unknown_flag() {
    let err = parse_args(["--unknown".to_string(), "/tmp/a".to_string()]).unwrap_err();

    assert!(err.contains("unknown argument"));
}

#[test]
fn rejects_append_with_create_parents() {
    let err = parse_args([
        "--append".to_string(),
        "--create-parents".to_string(),
        "/tmp/a".to_string(),
    ])
    .unwrap_err();

    assert!(err.contains("cannot be used together"));
}

#[test]
fn parse_private_append() {
    let args = parse_args([
        "--private".to_string(),
        "--append".to_string(),
        "/tmp/out.txt".to_string(),
    ])
    .unwrap();

    assert_eq!(
        args,
        Args {
            append: true,
            batch: false,
            create_parents: false,
            private: true,
            path: Some(PathBuf::from("/tmp/out.txt")),
        }
    );
}

#[test]
fn parse_batch() {
    let args = parse_args(["--batch".to_string()]).unwrap();

    assert_eq!(
        args,
        Args {
            append: false,
            batch: true,
            create_parents: false,
            private: false,
            path: None,
        }
    );
}

#[test]
fn parse_private_batch() {
    let args = parse_args(["--batch".to_string(), "--private".to_string()]).unwrap();

    assert_eq!(
        args,
        Args {
            append: false,
            batch: true,
            create_parents: false,
            private: true,
            path: None,
        }
    );
}

#[test]
fn rejects_batch_with_path() {
    let err = parse_args(["--batch".to_string(), "/tmp/out.txt".to_string()]).unwrap_err();

    assert!(err.contains("does not accept a path"));
}

#[test]
fn rejects_batch_with_single_file_flags() {
    let err = parse_args(["--batch".to_string(), "--create-parents".to_string()]).unwrap_err();

    assert!(err.contains("cannot be used"));
}

#[test]
fn rejects_private_with_create_parents() {
    let err = parse_args([
        "--private".to_string(),
        "--create-parents".to_string(),
        "/tmp/a".to_string(),
    ])
    .unwrap_err();

    assert!(err.contains("cannot be used together"));
}
