//! Materialize renamed Workflow documents without mutating their shared R2 package.

use crate::cleanup::{OptionalMountState, optional_mount_state};
use guest_contracts::{
    storage_files::StorageFile,
    storage_manifest::{StorageEntry, WORKFLOW_STORAGE_NAME},
};
use serde_yaml_ng::{Mapping, Value};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::{self, Read},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;

pub(crate) fn apply_all(entries: &[StorageEntry], skipped: &mut HashSet<String>) -> bool {
    for entry in entries {
        if entry.optional {
            if skipped.contains(&entry.mount_path) {
                continue;
            }
            if !entry.cached && entry.archive_url.is_none() {
                // Runner has already logged the preparation failure.
                skipped.insert(entry.mount_path.clone());
                continue;
            }
        }
        if let Err(error) = apply(entry) {
            if entry.optional {
                if let Err(error) = optional_mount_state(Path::new(&entry.mount_path)) {
                    guest_telemetry::log_error!(
                        crate::LOG_TAG,
                        "Unsafe optional package target {}: {error}",
                        entry.mount_path
                    );
                    return false;
                }
                record_optional_failure(entry, &error, skipped);
            } else {
                guest_telemetry::log_error!(
                    crate::LOG_TAG,
                    "Workflow document materialization failed: {error}"
                );
                return false;
            }
        }
    }
    true
}

fn record_optional_failure(
    entry: &StorageEntry,
    error: impl std::fmt::Display,
    skipped: &mut HashSet<String>,
) {
    guest_telemetry::log_error!(
        crate::LOG_TAG,
        "Optional package {} version {} failed: {error}",
        entry.mount_path,
        entry.vas_version_id.as_deref().unwrap_or("unknown")
    );
    skipped.insert(entry.mount_path.clone());
}

fn apply(entry: &StorageEntry) -> io::Result<()> {
    if entry.vas_storage_name.as_deref() != Some(WORKFLOW_STORAGE_NAME) {
        return Ok(());
    }
    let root = Path::new(&entry.mount_path);
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| io::Error::other("Workflow mount has no name"))?;
    if !name.contains("--wf-") && !name.ends_with("--instruction") {
        if entry.optional {
            open_document(&root.join("SKILL.md"), true)?;
        }
        return Ok(());
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
    let (source, instruction_package) = match read_document(&skill, entry.optional) {
        Ok(source) => (source, false),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound && name.ends_with("--instruction") =>
        {
            (
                read_document(&root.join("instructions.md"), entry.optional)?,
                true,
            )
        }
        Err(error) => return Err(error),
    };
    let Some(document) = render(&source, name, instruction_package)? else {
        return Ok(());
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
    )
}

fn open_document(path: &Path, optional: bool) -> io::Result<File> {
    let file = if optional {
        open_optional_document(path)?
    } else {
        open_regular_document(path)?
    };
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("Workflow document is not a regular file"));
    }
    Ok(file)
}

fn open_optional_document(path: &Path) -> io::Result<File> {
    #[cfg(target_os = "linux")]
    {
        use rustix::fs::{CWD, Mode, OFlags, ResolveFlags, openat2};
        use rustix::io::Errno;

        match openat2(
            CWD,
            path,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::NO_SYMLINKS,
        ) {
            Ok(file) => return Ok(File::from(file)),
            Err(Errno::NOSYS) => {}
            Err(error) => return Err(error.into()),
        }
    }

    let root = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Workflow document has no package root",
        )
    })?;
    match optional_mount_state(root)? {
        OptionalMountState::Directory => open_regular_document(path),
        OptionalMountState::Missing => Err(io::ErrorKind::NotFound.into()),
        OptionalMountState::Obstructed => Err(io::ErrorKind::NotADirectory.into()),
    }
}

fn open_regular_document(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

fn read_document(path: &Path, optional: bool) -> io::Result<String> {
    let mut source = String::new();
    open_document(path, optional)?
        .take(MAX_DOCUMENT_BYTES + 1)
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
