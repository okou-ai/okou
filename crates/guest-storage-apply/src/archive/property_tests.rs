use super::extract_tar_gz;
use crate::source::ArchiveSource;
use flate2::Compression;
use flate2::write::GzEncoder;
use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const CASES: u32 = 96;
const SEED: u64 = 0x3661_2A7A_2026_0924;
const CONTROL: &str = "__property_control.txt";
const CONTROL_CONTENT: &[u8] = b"accepted control";

#[derive(Clone, Copy, Debug)]
enum EntryKind {
    File,
    Directory,
    Symlink,
    Hardlink,
}

#[derive(Clone, Copy, Debug)]
enum EntryPath {
    Plain,
    NestedFile,
    NestedDirectory,
    Repeat,
    RepeatChild,
    DotDotInside,
    SiblingFile,
    SiblingDirectoryChild,
    AbsoluteSibling,
    AbsoluteInside,
    NewSibling,
    NestedDotDotOutside,
}

#[derive(Clone, Copy, Debug)]
enum LinkTarget {
    Plain,
    NestedFile,
    DotDotSiblingFile,
    DotDotSiblingDirectoryFile,
    AbsoluteSibling,
    AbsoluteInside,
    Repeat,
    Missing,
    NewSiblingDirectoryChild,
    NewSibling,
}

#[derive(Clone, Debug)]
struct GeneratedEntry {
    kind: EntryKind,
    path: EntryPath,
    link: LinkTarget,
}

struct Member {
    kind: EntryKind,
    path: String,
    link: Option<String>,
    content: Vec<u8>,
}

impl Member {
    fn file(path: impl Into<String>, content: &[u8]) -> Self {
        Self {
            kind: EntryKind::File,
            path: path.into(),
            link: None,
            content: content.to_vec(),
        }
    }

    fn link(kind: EntryKind, path: impl Into<String>, link: impl Into<String>) -> Self {
        Self {
            kind,
            path: path.into(),
            link: Some(link.into()),
            content: Vec::new(),
        }
    }
}

fn generated_entry() -> impl Strategy<Value = GeneratedEntry> {
    (
        prop::sample::select(vec![
            EntryKind::File,
            EntryKind::Directory,
            EntryKind::Symlink,
            EntryKind::Hardlink,
        ]),
        prop::sample::select(vec![
            EntryPath::Plain,
            EntryPath::NestedFile,
            EntryPath::NestedDirectory,
            EntryPath::Repeat,
            EntryPath::RepeatChild,
            EntryPath::DotDotInside,
            EntryPath::SiblingFile,
            EntryPath::SiblingDirectoryChild,
            EntryPath::AbsoluteSibling,
            EntryPath::AbsoluteInside,
            EntryPath::NewSibling,
            EntryPath::NestedDotDotOutside,
        ]),
        prop::sample::select(vec![
            LinkTarget::Plain,
            LinkTarget::NestedFile,
            LinkTarget::DotDotSiblingFile,
            LinkTarget::DotDotSiblingDirectoryFile,
            LinkTarget::AbsoluteSibling,
            LinkTarget::AbsoluteInside,
            LinkTarget::Repeat,
            LinkTarget::Missing,
            LinkTarget::NewSiblingDirectoryChild,
            LinkTarget::NewSibling,
        ]),
    )
        .prop_map(|(kind, path, link)| GeneratedEntry { kind, path, link })
}

fn entry_path(path: EntryPath, root: &Path) -> String {
    match path {
        EntryPath::Plain => "plain.txt".into(),
        EntryPath::NestedFile => "nested/file.txt".into(),
        EntryPath::NestedDirectory => "nested".into(),
        EntryPath::Repeat => "repeat".into(),
        EntryPath::RepeatChild => "repeat/child.txt".into(),
        EntryPath::DotDotInside => "nested/../repeat".into(),
        EntryPath::SiblingFile => "../outside.txt".into(),
        EntryPath::SiblingDirectoryChild => "../outside/new.txt".into(),
        EntryPath::AbsoluteSibling => root.join("outside.txt").to_str().unwrap().into(),
        EntryPath::AbsoluteInside => root
            .join("target/absolute-inside.txt")
            .to_str()
            .unwrap()
            .into(),
        EntryPath::NewSibling => "../new-sibling.txt".into(),
        EntryPath::NestedDotDotOutside => "nested/../../outside/preserved.txt".into(),
    }
}

fn link_target(link: LinkTarget, root: &Path) -> String {
    match link {
        LinkTarget::Plain => "plain.txt".into(),
        LinkTarget::NestedFile => "nested/file.txt".into(),
        LinkTarget::DotDotSiblingFile => "../outside.txt".into(),
        LinkTarget::DotDotSiblingDirectoryFile => "../outside/preserved.txt".into(),
        LinkTarget::AbsoluteSibling => root.join("outside.txt").to_str().unwrap().into(),
        LinkTarget::AbsoluteInside => root.join("target/plain.txt").to_str().unwrap().into(),
        LinkTarget::Repeat => "repeat".into(),
        LinkTarget::Missing => "missing.txt".into(),
        LinkTarget::NewSiblingDirectoryChild => "../outside/new.txt".into(),
        LinkTarget::NewSibling => "../new-sibling.txt".into(),
    }
}

fn materialize(entry: &GeneratedEntry, root: &Path) -> Member {
    let path = entry_path(entry.path, root);
    match entry.kind {
        EntryKind::File => Member::file(path, b"generated payload"),
        EntryKind::Directory => Member {
            kind: EntryKind::Directory,
            path,
            link: None,
            content: Vec::new(),
        },
        EntryKind::Symlink | EntryKind::Hardlink => {
            Member::link(entry.kind, path, link_target(entry.link, root))
        }
    }
}

// Builder rejects traversal names and absolute paths, so write valid headers
// directly to preserve the generated order of ordinary and adversarial entries.
#[allow(clippy::indexing_slicing)]
fn tar_gz(members: &[Member]) -> Vec<u8> {
    let mut tar = Vec::new();
    for member in members {
        let mut header = [0u8; 512];
        let path = member.path.as_bytes();
        assert!(path.len() <= 100);
        header[..path.len()].copy_from_slice(path);
        header[100..108].copy_from_slice(match member.kind {
            EntryKind::Directory => b"0000755\0",
            EntryKind::Symlink => b"0000777\0",
            EntryKind::File | EntryKind::Hardlink => b"0000644\0",
        });
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        let size = format!("{:011o}\0", member.content.len());
        header[124..136].copy_from_slice(size.as_bytes());
        header[136..148].copy_from_slice(b"00000000000\0");
        header[156] = match member.kind {
            EntryKind::File => b'0',
            EntryKind::Directory => b'5',
            EntryKind::Symlink => b'2',
            EntryKind::Hardlink => b'1',
        };
        if let Some(link) = &member.link {
            assert!(link.len() <= 100);
            header[157..157 + link.len()].copy_from_slice(link.as_bytes());
        }
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        header[148..156].fill(b' ');
        let checksum: u32 = header.iter().map(|&byte| u32::from(byte)).sum();
        header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());

        tar.extend_from_slice(&header);
        tar.extend_from_slice(&member.content);
        tar.resize(tar.len().div_ceil(512) * 512, 0);
    }
    tar.extend_from_slice(&[0; 1024]);

    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(&tar).unwrap();
    encoder.finish().unwrap()
}

#[derive(Debug, PartialEq, Eq)]
enum ObjectKind {
    File(Vec<u8>),
    Directory,
    Symlink(PathBuf),
}

#[derive(Debug, PartialEq, Eq)]
struct ObjectState {
    kind: ObjectKind,
    mode: u32,
    modified: SystemTime,
}

fn snapshot_outside(root: &Path, target: &Path) -> BTreeMap<PathBuf, ObjectState> {
    fn visit(root: &Path, path: &Path, objects: &mut BTreeMap<PathBuf, ObjectState>) {
        let metadata = fs::symlink_metadata(path).unwrap();
        let kind = if metadata.file_type().is_symlink() {
            ObjectKind::Symlink(fs::read_link(path).unwrap())
        } else if metadata.is_dir() {
            ObjectKind::Directory
        } else {
            ObjectKind::File(fs::read(path).unwrap())
        };
        objects.insert(
            path.strip_prefix(root).unwrap().to_path_buf(),
            ObjectState {
                kind,
                mode: metadata.permissions().mode(),
                modified: metadata.modified().unwrap(),
            },
        );
        if metadata.is_dir() {
            for child in fs::read_dir(path).unwrap() {
                visit(root, &child.unwrap().path(), objects);
            }
        }
    }

    let mut objects = BTreeMap::new();
    for child in fs::read_dir(root).unwrap() {
        let path = child.unwrap().path();
        if path != target {
            visit(root, &path, &mut objects);
        }
    }
    objects
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: CASES,
        rng_seed: RngSeed::Fixed(SEED),
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn generated_archives_do_not_change_siblings(
        entries in proptest::collection::vec(generated_entry(), 1..=8)
    ) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("target");
        fs::create_dir(&target).unwrap();
        fs::write(root.join("outside.txt"), b"outside sentinel").unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        fs::write(root.join("outside/preserved.txt"), b"nested sentinel").unwrap();
        let before = snapshot_outside(&root, &target);

        let mut members = vec![Member::file(CONTROL, CONTROL_CONTENT)];
        members.extend(entries.iter().map(|entry| materialize(entry, &root)));
        let archive = tar_gz(&members);
        let result = extract_tar_gz(ArchiveSource::local(Cursor::new(archive), None), &target);

        prop_assert_eq!(
            snapshot_outside(&root, &target), before,
            "result ok: {}, generated entries: {:?}", result.is_ok(), entries
        );
        prop_assert!(
            fs::read(target.join(CONTROL)).is_ok_and(|content| content == CONTROL_CONTENT),
            "accepted control missing after generated entries: {:?}", entries
        );
    }
}

#[test]
fn outside_tree_is_unchanged_after_late_unpack_error() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let target = root.join("target");
    fs::create_dir(&target).unwrap();
    fs::write(root.join("outside.txt"), b"outside sentinel").unwrap();
    let before = snapshot_outside(&root, &target);
    let members = [
        Member::file(CONTROL, CONTROL_CONTENT),
        Member::file("repeat", b"first"),
        Member::file("repeat", b"second"),
        Member::file("repeat/child", b"cannot unpack beneath a file"),
    ];

    let result = extract_tar_gz(
        ArchiveSource::local(Cursor::new(tar_gz(&members)), None),
        &target,
    );

    assert!(result.is_err());
    assert_eq!(fs::read(target.join(CONTROL)).unwrap(), CONTROL_CONTENT);
    assert_eq!(fs::read(target.join("repeat")).unwrap(), b"second");
    assert_eq!(snapshot_outside(&root, &target), before);
}

#[test]
fn valid_mixed_entries_are_extracted() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    fs::create_dir(&target).unwrap();
    let target = target.canonicalize().unwrap();
    let members = [
        Member::file("source.txt", b"source"),
        Member {
            kind: EntryKind::Directory,
            path: "folder".into(),
            link: None,
            content: Vec::new(),
        },
        Member::file("folder/nested.txt", b"nested"),
        Member::link(EntryKind::Symlink, "alias", "source.txt"),
        Member::link(EntryKind::Hardlink, "copy", "source.txt"),
    ];
    let archive = tar_gz(&members);

    extract_tar_gz(ArchiveSource::local(Cursor::new(archive), None), &target)
        .unwrap_or_else(|error| panic!("accepted archive failed: {error}"));
    assert_eq!(fs::read(target.join("source.txt")).unwrap(), b"source");
    assert!(fs::metadata(target.join("folder")).unwrap().is_dir());
    assert_eq!(
        fs::read(target.join("folder/nested.txt")).unwrap(),
        b"nested"
    );
    assert_eq!(
        fs::read_link(target.join("alias")).unwrap(),
        Path::new("source.txt")
    );
    assert_eq!(fs::read(target.join("copy")).unwrap(), b"source");
}
