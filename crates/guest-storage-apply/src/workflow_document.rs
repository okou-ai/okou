//! Materialize renamed Workflow documents without mutating their shared R2 package.

use guest_contracts::{storage_files::StorageFile, storage_manifest::StorageEntry};
use serde_yaml_ng::{Mapping, Value};
use std::{
    fs::OpenOptions,
    io::{self, Read},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;

pub(crate) fn apply(entries: &[StorageEntry]) -> io::Result<()> {
    for entry in entries {
        if entry.vas_storage_name.as_deref() != Some("workflow") {
            continue;
        }
        let root = Path::new(&entry.mount_path);
        let name = root
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| io::Error::other("Workflow mount has no name"))?;
        if !name.contains("--wf-") && !name.ends_with("--instruction") {
            continue;
        }
        if name.is_empty()
            || name.len() > 64
            || name.starts_with('-')
            || name.ends_with('-')
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(io::Error::other("Invalid Workflow document name"));
        }
        let skill = root.join("SKILL.md");
        let (source, instruction_package) = match read_document(&skill) {
            Ok(source) => (source, false),
            Err(error)
                if error.kind() == io::ErrorKind::NotFound && name.ends_with("--instruction") =>
            {
                (read_document(&root.join("instructions.md"))?, true)
            }
            Err(error) => return Err(error),
        };
        let Some(document) = render(&source, name, instruction_package)? else {
            continue;
        };
        crate::files::materialize(
            &[StorageFile {
                path: "SKILL.md".into(),
                content: document.into_bytes(),
                mode: 0o644,
                mtime: 1,
            }],
            root,
            1,
        )?;
    }
    Ok(())
}

fn read_document(path: &Path) -> io::Result<String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("Workflow document is not a regular file"));
    }
    let mut source = String::new();
    file.take(MAX_DOCUMENT_BYTES + 1)
        .read_to_string(&mut source)?;
    if source.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(io::Error::other(
            "Workflow document exceeds the package limit",
        ));
    }
    Ok(source)
}

fn render(source: &str, name: &str, instruction_package: bool) -> io::Result<Option<String>> {
    let (mut header, body) = if instruction_package {
        let mut header = Mapping::new();
        header.insert(
            Value::String("description".into()),
            Value::String(name.into()),
        );
        (header, source)
    } else {
        let without_open = source
            .strip_prefix("---\n")
            .or_else(|| source.strip_prefix("---\r\n"))
            .ok_or_else(|| io::Error::other("Workflow document has no frontmatter"))?;
        let (end, delimiter_len) = without_open
            .find("\n---\n")
            .map(|end| (end, 5))
            .or_else(|| without_open.find("\n---\r\n").map(|end| (end, 6)))
            .ok_or_else(|| io::Error::other("Workflow document has incomplete frontmatter"))?;
        let header: Mapping = serde_yaml_ng::from_str(&without_open[..end])
            .map_err(|_| io::Error::other("Invalid Workflow frontmatter"))?;
        if header
            .get(Value::String("name".into()))
            .and_then(Value::as_str)
            == Some(name)
        {
            return Ok(None);
        }
        (header, &without_open[end + delimiter_len..])
    };
    header.insert(Value::String("name".into()), Value::String(name.into()));
    let yaml = serde_yaml_ng::to_string(&header)
        .map_err(|_| io::Error::other("Cannot render Workflow frontmatter"))?;
    Ok(Some(format!("---\n{}---\n\n{}\n", yaml, body.trim())))
}
