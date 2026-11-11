//! Replay one immutable Run delta onto each freshly observed Memory HEAD.

use super::api::{PrepareSnapshotRequest, prepare_snapshot};
use super::archive::{ARTIFACT_TRAVERSAL_MAX_DEPTH, ARTIFACT_TRAVERSAL_MAX_PATH_BYTES};
use super::{
    CreateSnapshotRequest, FileEntry, SnapshotPublication, SnapshotResult, create_archive_bundle,
    create_snapshot,
};
use crate::content_hash::compute_content_hash;
use crate::error::AgentError;
use crate::http::HttpClient;
use api_contracts::generated::constants::storages::{
    STORAGE_MANIFEST_MAX_FILES, STORAGE_MANIFEST_MAX_PATH_BYTES,
};
use api_contracts::generated::types::webhooks::agent::storages::prepare::ResponseMemoryMerge;
use flate2::read::MultiGzDecoder;
use guest_telemetry::log_info;
use guest_telemetry::telemetry::record_sandbox_op;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;
use std::sync::Arc;

const MAX_MERGE_ATTEMPTS: usize = 16;
// The upload boundary permits 100 MiB of file contents plus bounded tar headers/paths.
const MAX_CONTENT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
// Allow JSON escaping of the full path-byte budget as well as entry metadata.
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
type Files = BTreeMap<String, FileEntry>;

struct Delta {
    writes: Files,
    deletes: BTreeSet<String>,
}

#[derive(Deserialize)]
struct Manifest {
    files: Vec<FileEntry>,
}

pub(crate) async fn create_memory_snapshot(
    http: &HttpClient,
    request: CreateSnapshotRequest<'_>,
) -> Result<SnapshotResult, AgentError> {
    let original = create_snapshot(
        http,
        CreateSnapshotRequest {
            files: request.files.clone(),
            ..request
        },
    )
    .await?;
    if matches!(original.publication, SnapshotPublication::Published) {
        return Ok(original);
    }
    let started = std::time::Instant::now();
    let result = recover_memory(http, &request, original).await;
    record_sandbox_op(
        "memory_merge",
        started.elapsed(),
        result
            .as_ref()
            .is_ok_and(|snapshot| matches!(snapshot.publication, SnapshotPublication::Published)),
        None,
    );
    result
}

async fn merge_context(
    http: &HttpClient,
    request: &CreateSnapshotRequest<'_>,
) -> Result<Option<ResponseMemoryMerge>, AgentError> {
    let prepared = prepare_snapshot(
        http,
        PrepareSnapshotRequest {
            run_id: request.run_id,
            storage_id: request.storage_id,
            files: &request.files,
            parent_version_id: request.parent_version_id,
            include_memory_merge: true,
        },
    )
    .await
    .map_err(|error| error.into_parts().0)?;
    Ok(prepared.memory_merge)
}

async fn recover_memory(
    http: &HttpClient,
    request: &CreateSnapshotRequest<'_>,
    mut original: SnapshotResult,
) -> Result<SnapshotResult, AgentError> {
    let Some(mut context) = merge_context(http, request).await? else {
        // A draining/rolled-back old API has no merge capability. Preserve its
        // existing retained-conflict outcome without claiming publication.
        // Remove when APIs without merge inputs neither serve nor remain valid
        // rollback targets; #46528 tracks that release/drain/rollback gate.
        return Ok(original);
    };
    if context.base.version_id != request.parent_version_id {
        return Err(invalid(
            "captured base differs from the Run's mounted version",
        ));
    }
    let ours = validate_files(
        request.storage_id,
        &original.version_id,
        request.files.clone(),
    )?;
    let base = download_manifest(
        http,
        request.storage_id,
        &context.base.version_id,
        context.base.empty,
        context.base.manifest_url.as_deref(),
    )
    .await?;
    let delta = Delta {
        deletes: base
            .keys()
            .filter(|path| !ours.contains_key(*path))
            .cloned()
            .collect(),
        writes: ours
            .into_iter()
            .filter(|(path, file)| base.get(path).is_none_or(|old| old.hash != file.hash))
            .collect(),
    };
    // Uploaded candidates retain their exact archive. The deduplicated branch
    // freezes its validated original bytes once before any merge is attempted.
    let frozen = match original.archive.take() {
        Some(archive) => archive,
        None => create_archive_bundle(request.mount_path, Arc::from(request.files.clone())).await?,
    };
    let frozen = Arc::new(frozen);
    for attempt in 1..=MAX_MERGE_ATTEMPTS {
        let head = download_manifest(
            http,
            request.storage_id,
            &context.head.version_id,
            context.head.empty,
            context.head.manifest_url.as_deref(),
        )
        .await?;
        let merged = apply_delta(head, &delta);
        let merged_files = merged.values().cloned().collect::<Vec<_>>();
        let version = compute_content_hash(
            request.storage_id,
            merged_files
                .iter()
                .map(|file| (file.path.as_str(), file.hash.as_str())),
        );
        validate_files(request.storage_id, &version, merged_files.clone())?;
        let head_files: Files = merged
            .iter()
            .filter(|(path, _)| !delta.writes.contains_key(*path))
            .map(|(path, file)| (path.clone(), file.clone()))
            .collect();
        let staging = tempfile::tempdir()?;
        let head_archive = staging.path().join("head.tar.gz");
        if !head_files.is_empty() {
            let url = context
                .head
                .archive_url
                .as_deref()
                .ok_or_else(|| invalid("HEAD archive URL is missing"))?;
            http.get_presigned_file(url, &head_archive, MAX_ARCHIVE_BYTES)
                .await?;
        }
        let tree = staging.path().join("tree");
        let frozen_archive = Arc::clone(&frozen);
        let writes = delta.writes.clone();
        let tree_path = tree.clone();
        let staging = tokio::task::spawn_blocking(move || {
            fs::create_dir(&tree_path)?;
            copy_archive_files(&head_archive, &head_files, &tree_path)?;
            copy_archive_files(&frozen_archive.archive_path, &writes, &tree_path)?;
            Ok::<_, AgentError>(staging)
        })
        .await
        .map_err(|error| AgentError::Execution(format!("Memory merge task failed: {error}")))??;
        let _staging = staging;
        let mount_path = tree
            .to_str()
            .ok_or_else(|| invalid("temporary path is not UTF-8"))?;
        let snapshot = create_snapshot(
            http,
            CreateSnapshotRequest {
                mount_path,
                files: merged_files,
                storage_id: request.storage_id,
                run_id: request.run_id,
                message: request.message,
                parent_version_id: &context.head.version_id,
            },
        )
        .await?;
        if matches!(snapshot.publication, SnapshotPublication::Published) {
            log_info!(
                super::LOG_TAG,
                "Memory merge published {} after {attempt} attempt(s)",
                snapshot.version_id
            );
            return Ok(snapshot);
        }
        if attempt == MAX_MERGE_ATTEMPTS {
            break;
        }
        context = merge_context(http, request)
            .await?
            .ok_or_else(|| invalid("merge capability disappeared during publication"))?;
        if context.base.version_id != request.parent_version_id {
            return Err(invalid("captured base changed during publication"));
        }
    }
    Err(invalid("publication exhausted concurrent HEAD retries"))
}

fn invalid(message: &str) -> AgentError {
    AgentError::Finalization(format!("Memory merge failed: {message}"))
}

async fn download_manifest(
    http: &HttpClient,
    storage_id: &str,
    version: &str,
    empty: bool,
    url: Option<&str>,
) -> Result<Files, AgentError> {
    if empty {
        return validate_files(storage_id, version, Vec::new());
    }
    let url = url.ok_or_else(|| invalid("manifest URL is missing"))?;
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("manifest.json");
    http.get_presigned_file(url, &path, MAX_MANIFEST_BYTES)
        .await?;
    let bytes = tokio::fs::read(path).await?;
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    validate_files(storage_id, version, manifest.files)
}

fn validate_files(
    storage_id: &str,
    version: &str,
    files: Vec<FileEntry>,
) -> Result<Files, AgentError> {
    if files.len() as u64 > STORAGE_MANIFEST_MAX_FILES {
        return Err(invalid("manifest exceeds the file limit"));
    }
    let mut result = Files::new();
    let mut bytes = 0_u64;
    let mut path_bytes = 0_u64;
    for file in files {
        if file.path.len() as u64 > ARTIFACT_TRAVERSAL_MAX_PATH_BYTES
            || file.path.split('/').enumerate().any(|(depth, part)| {
                depth as u64 > ARTIFACT_TRAVERSAL_MAX_DEPTH
                    || part.is_empty()
                    || part == "."
                    || part == ".."
            })
            || file.path.contains('\0')
            || file.hash.len() != 64
            || !file.hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid("manifest contains an invalid path or hash"));
        }
        bytes = bytes.saturating_add(file.size);
        path_bytes = path_bytes.saturating_add(file.path.len() as u64);
        if bytes > MAX_CONTENT_BYTES || path_bytes > STORAGE_MANIFEST_MAX_PATH_BYTES {
            return Err(invalid("manifest exceeds the size limit"));
        }
        if result.insert(file.path.clone(), file).is_some() {
            return Err(invalid("manifest contains duplicate paths"));
        }
    }
    for path in result.keys() {
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if result.contains_key(prefix) {
                return Err(invalid("manifest contains incompatible file paths"));
            }
            parent = prefix;
        }
    }
    if compute_content_hash(
        storage_id,
        result
            .values()
            .map(|file| (file.path.as_str(), file.hash.as_str())),
    ) != version
    {
        return Err(invalid("manifest does not match its version"));
    }
    Ok(result)
}

fn apply_delta(mut head: Files, delta: &Delta) -> Files {
    for path in &delta.deletes {
        head.remove(path);
    }
    for (path, file) in &delta.writes {
        // A file replacing a directory (or the reverse) is a candidate-wins
        // path conflict. Remove incompatible HEAD paths before writing it.
        let descendants = format!("{path}/");
        let obsolete: Vec<_> = head
            .range(descendants.clone()..)
            .take_while(|(other, _)| other.starts_with(&descendants))
            .map(|(other, _)| other.clone())
            .collect();
        for other in obsolete {
            head.remove(&other);
        }
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            head.remove(prefix);
            parent = prefix;
        }
        head.insert(path.clone(), file.clone());
    }
    head
}

fn copy_archive_files(archive_path: &Path, files: &Files, root: &Path) -> Result<(), AgentError> {
    if files.is_empty() {
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    let root = crate::nofollow_fs::Dir::open_absolute(root)?;
    let input = MultiGzDecoder::new(File::open(archive_path)?).take(MAX_ARCHIVE_BYTES + 1);
    let mut archive = tar::Archive::new(input);
    let mut found = BTreeSet::new();
    for (index, entry) in archive.entries()?.enumerate() {
        if index as u64 >= 2 * STORAGE_MANIFEST_MAX_FILES {
            return Err(invalid("archive exceeds the entry limit"));
        }
        let mut entry = entry?;
        let path = entry
            .path()?
            .to_str()
            .ok_or_else(|| invalid("archive path is not UTF-8"))?
            .to_owned();
        let Some(expected) = files.get(&path) else {
            continue;
        };
        if !entry.header().entry_type().is_file()
            || entry.size() != expected.size
            || !found.insert(path.clone())
        {
            return Err(invalid("archive entry does not match the manifest"));
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        if bytes.len() as u64 != expected.size
            || hex::encode(Sha256::digest(&bytes)) != expected.hash
        {
            return Err(invalid("archive file does not match its hash"));
        }
        #[cfg(target_os = "linux")]
        {
            write_archive_file(&root, &path, &bytes, entry.header().mode()? & 0o777)?;
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = root;
            return Err(invalid("archive reconstruction requires Linux"));
        }
    }
    let mut input = archive.into_inner();
    io::copy(&mut input, &mut io::sink())?;
    if input.limit() == 0 || found.len() != files.len() {
        return Err(invalid("archive is incomplete or exceeds the size limit"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn write_archive_file(
    root: &crate::nofollow_fs::Dir,
    path: &str,
    bytes: &[u8],
    mode: u32,
) -> Result<(), AgentError> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Component;

    // Like the snapshot producer, resolve one component at a time. A valid
    // manifest path can exceed the kernel's full-path syscall limit.
    let mut parent = root.try_clone()?;
    let mut components = Path::new(path).components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(invalid("archive path contains a non-normal component"));
        };
        if components.peek().is_none() {
            let mut file = parent.create_child_file(name)?;
            file.write_all(bytes)?;
            file.set_permissions(fs::Permissions::from_mode(mode))?;
            return Ok(());
        }
        parent = parent.create_child_dir(name)?;
    }
    Err(invalid("archive path is empty"))
}

#[cfg(all(test, unix))]
mod tests;
