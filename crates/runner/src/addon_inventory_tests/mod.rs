use super::ADDON_FILES;

#[test]
fn generated_addon_inventory_matches_shipped_sources() {
    fn collect(root: &std::path::Path, current: &std::path::Path, names: &mut Vec<String>) {
        for entry in std::fs::read_dir(current).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                let name = path.file_name().unwrap().to_string_lossy();
                if name != "__pycache__" && !name.starts_with('.') {
                    collect(root, &path, names);
                }
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy();
            if path.extension().is_some_and(|extension| extension == "py")
                || ["LICENSE", "COPYING", "NOTICE"]
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
            {
                names.push(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("mitm-addon/src");
    let mut expected = Vec::new();
    collect(&root, &root, &mut expected);
    expected.sort();
    let actual = ADDON_FILES
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
    assert!(ADDON_FILES.iter().all(|(_, content)| !content.is_empty()));
}
