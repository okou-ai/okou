use std::io;

use linux_mountinfo::{Mount, parse};

#[test]
fn unicode_whitespace_in_root_and_target_is_path_data() {
    for whitespace in ['\u{a0}', '\u{85}', '\u{2003}', '\u{2028}'] {
        for target in ["/tmp/ascii".to_owned(), format!("/tmp/a{whitespace}b")] {
            for root in ["/".to_owned(), format!("/root{whitespace}dir")] {
                let input = format!(
                    "42 25 253:17 {root} {target} rw shared:7 master:9 propagate_from:3 - ext4 /dev/vdb rw\n"
                );

                let mounts = parse(input.as_bytes())
                    .collect::<io::Result<Vec<_>>>()
                    .unwrap();

                assert_eq!(
                    mounts,
                    [Mount {
                        id: 42,
                        device: (253, 17),
                        root: root.as_bytes().to_vec(),
                        target: target.as_bytes().to_vec(),
                    }],
                );
            }
        }
    }
}

#[test]
fn non_utf8_paths_do_not_invalidate_other_records() {
    let input = b"42 25 0:32 /root/\xff /tmp/\xfe rw - ext4 /dev/\xfd rw\n\
43 25 0:33 / /tmp/ascii rw - ext4 /dev/vdc rw\n";

    let mounts = parse(input).collect::<io::Result<Vec<_>>>().unwrap();

    assert_eq!(mounts.len(), 2);
    assert_eq!(mounts[0].root, b"/root/\xff");
    assert_eq!(mounts[0].target, b"/tmp/\xfe");
    assert_eq!(mounts[1].target, b"/tmp/ascii");
}

#[test]
fn does_not_interpret_the_filesystem_specific_mount_source() {
    let input = b"42 25 0:32 / /tmp rw - tmpfs  rw\n";

    let mounts = parse(input).collect::<io::Result<Vec<_>>>().unwrap();

    assert_eq!(mounts[0].target, b"/tmp");
}

#[test]
fn only_kernel_field_delimiters_split_path_bytes() {
    let input = b"42 25 0:32 / /tmp/a\rb\x0bc\x0cd rw - ext4 /dev/vdb rw";

    let mounts = parse(input).collect::<io::Result<Vec<_>>>().unwrap();

    assert_eq!(mounts[0].target, b"/tmp/a\rb\x0bc\x0cd");
}

#[test]
fn decodes_all_kernel_escapes_once() {
    let input = br"42 25 0:32 /root\040tab\011newline\012backslash\134040 /space\040tab\011newline\012backslash\134040 rw - ext4 /dev/vdb rw";

    let mounts = parse(input).collect::<io::Result<Vec<_>>>().unwrap();

    assert_eq!(mounts[0].root, b"/root tab\tnewline\nbackslash\\040");
    assert_eq!(mounts[0].target, b"/space tab\tnewline\nbackslash\\040");
}

#[test]
fn rejects_incomplete_and_non_kernel_path_escapes() {
    for escape in [
        r"\", r"\0", r"\04", r"\041", r"\000", r"\377", r"\777", r"\xyz",
    ] {
        for (root, target) in [
            ("/".to_string(), format!("/tmp/{escape}")),
            (format!("/root/{escape}"), "/tmp".to_string()),
        ] {
            let input = format!("42 25 0:32 {root} {target} rw - ext4 /dev/vdb rw");
            let error = parse(input.as_bytes()).next().unwrap().unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{escape}");
        }
    }
}

#[test]
fn rejects_malformed_records_and_mount_identity() {
    for input in [
        "42 25 0:32 / /tmp rw ext4 /dev/vdb rw",
        "42 25 0:32 / /tmp - ext4 /dev/vdb rw",
        "42 25 0:32 / /tmp rw - ext4 /dev/vdb",
        "42 25 0:32 / /tmp rw - ext4 /dev/vdb rw extra",
        "42 25 0:32 /  rw - ext4 /dev/vdb rw",
        " 42 25 0:32 / /tmp rw - ext4 /dev/vdb rw",
        "invalid 25 0:32 / /tmp rw - ext4 /dev/vdb rw",
        "-1 25 0:32 / /tmp rw - ext4 /dev/vdb rw",
        "18446744073709551616 25 0:32 / /tmp rw - ext4 /dev/vdb rw",
        "42 25 invalid:32 / /tmp rw - ext4 /dev/vdb rw",
        "42 25 4294967296:32 / /tmp rw - ext4 /dev/vdb rw",
        "42 25 0:4294967296 / /tmp rw - ext4 /dev/vdb rw",
        "42 25 0 / /tmp rw - ext4 /dev/vdb rw",
        "42 25 0: / /tmp rw - ext4 /dev/vdb rw",
        "42 25 :32 / /tmp rw - ext4 /dev/vdb rw",
        "42 25 0:32:1 / /tmp rw - ext4 /dev/vdb rw",
    ] {
        let error = parse(input.as_bytes()).next().unwrap().unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{input}");
    }
}

#[test]
fn callers_can_handle_invalid_records_independently() {
    let input = b"42 25 0:32 / /tmp/first rw - ext4 /dev/vdb rw\n\
malformed\n\
43 25 0:33 / /tmp/second rw - ext4 /dev/vdc rw";
    let mut records = parse(input);

    assert_eq!(records.next().unwrap().unwrap().target, b"/tmp/first");
    assert_eq!(
        records.next().unwrap().unwrap_err().kind(),
        io::ErrorKind::InvalidData,
    );
    assert_eq!(records.next().unwrap().unwrap().target, b"/tmp/second");
    assert!(records.next().is_none());
}

#[test]
fn empty_tables_and_blank_lines_yield_no_records() {
    for input in [b"".as_slice(), b"\n\n"] {
        assert!(parse(input).next().is_none());
    }
}
