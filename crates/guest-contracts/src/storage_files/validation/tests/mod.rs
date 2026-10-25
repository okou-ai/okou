use std::io;
use std::path::{Component, MAIN_SEPARATOR_STR, Path, PathBuf};

use crate::storage_files::{StorageFile, validate_files};

fn file(path: &str) -> StorageFile {
    StorageFile {
        path: path.into(),
        mode: 0o640,
        mtime: 1,
        content: Vec::new(),
    }
}

fn reference_accepts(paths: &[&str]) -> bool {
    !paths.is_empty()
        && paths.iter().all(|raw| {
            let path = Path::new(raw);
            !raw.is_empty()
                && !raw.as_bytes().contains(&0)
                && path
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
                && path.components().collect::<PathBuf>().as_os_str() == path.as_os_str()
        })
        && paths.iter().enumerate().all(|(index, path)| {
            paths.iter().enumerate().all(|(other_index, other)| {
                index == other_index || !Path::new(path).starts_with(other)
            })
        })
}

fn assert_matches_reference(paths: &[&str]) {
    let files = paths.iter().map(|path| file(path)).collect::<Vec<_>>();
    let result = validate_files(&files);
    assert_eq!(result.is_ok(), reference_accepts(paths), "{paths:?}");
    if let Err(error) = result {
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}

#[test]
fn canonical_path_validation_matches_component_reconstruction() {
    let parts = [
        "", ".", "..", "a", "a-b", "a.b", "a\\b", "雪", "a\0b", "C:", "C:child",
    ];
    for first in parts {
        assert_matches_reference(&[first]);
        for second in parts {
            for separator in ["/", "//", "\\", MAIN_SEPARATOR_STR] {
                let path = format!("{first}{separator}{second}");
                assert_matches_reference(&[&path]);
                assert_matches_reference(&[&format!("{separator}{path}")]);
                assert_matches_reference(&[&format!("{path}{separator}")]);
                for third in parts {
                    assert_matches_reference(&[&format!("{path}{separator}{third}")]);
                }
            }
        }
    }
}

#[test]
fn file_conflicts_match_pairwise_components_in_any_order() {
    let native = MAIN_SEPARATOR_STR;
    let paths = [
        "a".into(),
        "a-b".into(),
        "a-bc".into(),
        format!("a{native}b"),
        format!("a{native}c"),
        format!("a-b{native}c"),
        format!("a-bc{native}d"),
        format!("a{native}b{native}deep"),
        format!("a{native}b-c"),
        format!("a{native}b-c{native}d"),
        format!("雪{native}子"),
        "z".into(),
    ];
    assert_matches_reference(&[]);
    for first in &paths {
        for second in &paths {
            for third in &paths {
                assert_matches_reference(&[first, second, third]);
            }
        }
    }
}

#[test]
fn byte_prefix_distractors_do_not_hide_ancestor_owners() {
    for paths in [
        vec!["a", "a-b", "a-b/c"],
        vec!["a/b", "a-bc", "a-b", "a"],
        vec!["a-b/c/deep", "a-bd", "a-b/c", "a/b"],
        vec!["a-b/c", "a-bd", "a/b", "z"],
        vec!["a/b-c/d", "a/b-d", "a/c", "a/b/c"],
        vec!["a/b-c/d", "a/b-d", "a/c", "a/b/c", "a/b"],
    ] {
        let paths = paths
            .into_iter()
            .map(|path| path.replace('/', MAIN_SEPARATOR_STR))
            .collect::<Vec<_>>();
        let borrowed = paths.iter().map(String::as_str).collect::<Vec<_>>();
        assert_matches_reference(&borrowed);
        let mut reversed = borrowed;
        reversed.reverse();
        assert_matches_reference(&reversed);
    }
}
