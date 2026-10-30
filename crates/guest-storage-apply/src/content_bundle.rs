//! Install verified run-private package files without trusting writable Guest cache state.
use crate::cleanup_directory::CleanupDirectory;
use guest_contracts::content_bundle::{BundleApplication, MAX_METADATA_BYTES};
use std::{collections::HashSet, fs, io, os::unix::fs::PermissionsExt, path::Path};

pub fn apply_content_bundle(home: &Path, runtime: &Path, metadata: &[u8]) -> bool {
    apply(home, runtime, metadata).is_ok()
}
fn apply(home: &Path, runtime: &Path, metadata: &[u8]) -> io::Result<()> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid content bundle application",
        )
    };
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(invalid());
    }
    let input: BundleApplication = serde_json::from_slice(metadata).map_err(|_| invalid())?;
    let safe_source = |source: &str| -> io::Result<()> {
        let path = Path::new(source);
        if path.parent() != Some(runtime)
            || !path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("bundle-"))
            || !fs::symlink_metadata(path)?.file_type().is_file()
        {
            return Err(invalid());
        }
        Ok(())
    };
    match input {
        BundleApplication::Instructions { framework, source } => {
            safe_source(&source)?;
            if !crate::instructions::apply_agent_instructions(home, &framework, Path::new(&source))
            {
                return Err(invalid());
            }
            fs::remove_file(source)
        }
        BundleApplication::Skill { mount, files } => {
            let Some(relative) =
                crate::instructions::workflow_skill_relative_mount(home, Path::new(&mount))
            else {
                return Err(invalid());
            };
            if files.is_empty() || files.len() > 501 || !files.iter().any(|f| f.path == "SKILL.md")
            {
                return Err(invalid());
            }
            let mut paths = HashSet::new();
            let mut total = 0u64;
            for file in &files {
                safe_source(&file.source)?;
                if file.path.is_empty()
                    || file.path.encode_utf16().count() > 256
                    || file.path.contains(['\\', '\0'])
                    || file
                        .path
                        .split('/')
                        .any(|p| p.is_empty() || p == "." || p == "..")
                    || !paths.insert(file.path.clone())
                {
                    return Err(invalid());
                }
                total = total.saturating_add(fs::metadata(&file.source)?.len());
                if total > 32 * 1024 * 1024 {
                    return Err(invalid());
                }
            }
            // All package paths are validated before touching a managed destination.
            let target = home.join(relative);
            let parent = target.parent().ok_or_else(invalid)?;
            let mut dir = home.to_path_buf();
            for part in parent
                .strip_prefix(home)
                .map_err(|_| invalid())?
                .components()
            {
                dir.push(part);
                match fs::create_dir(&dir) {
                    Ok(()) => fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?,
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(e),
                }
                if !fs::symlink_metadata(&dir)?.file_type().is_dir() {
                    return Err(invalid());
                }
            }
            let pinned = CleanupDirectory::open(parent)?;
            let staging = runtime.join("bundle-skill-staging");
            match fs::remove_dir_all(&staging) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            fs::create_dir(&staging)?;
            fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))?;
            for file in &files {
                let destination = staging.join(&file.path);
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(&file.source, &destination)?;
                fs::set_permissions(&destination, fs::Permissions::from_mode(0o600))?;
            }
            let target = pinned
                .proc_path()
                .join(target.file_name().ok_or_else(invalid)?);
            match fs::symlink_metadata(&target) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    fs::remove_dir_all(&target)?
                }
                Ok(_) => return Err(invalid()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            fs::rename(staging, target)?;
            for file in files {
                fs::remove_file(file.source)?;
            }
            Ok(())
        }
    }
}
