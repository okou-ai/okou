//! The fixture records its actual snapshot creator; it does not attest bootstrap history.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use sandbox::SnapshotCreateConfig;
use sandbox_firecracker::{SNAPSHOT_COMPLETE_MARKER_CONTENT, SnapshotOutputPaths};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::evidence::{Artifacts, clocks, compiled_source, file_sha256};
use super::{TestResult, fixture, io};

pub(super) const RECORD_FILE: &str = "snapshot-preparation.json";
const FORMAT: &str = "native-snapshot-preparation-v1";
const MAX_RECORD_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Profile {
    vcpu: u32,
    memory_mib: u32,
    home_mib: u32,
}

impl Profile {
    fn native() -> Self {
        Self {
            vcpu: fixture::PROFILE_DEFINITION.vcpu,
            memory_mib: fixture::PROFILE_DEFINITION.memory_mb,
            home_mib: fixture::HOME_DISK_MB,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Inputs {
    source_sha: String,
    producer_test_binary_sha256: String,
    firecracker_sha256: String,
    kernel_sha256: String,
    rootfs_sha256: String,
    snapshot_id: String,
    profile: Profile,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    format: String,
    inputs: Inputs,
    #[serde(deserialize_with = "unique_snapshot_files")]
    snapshot_files: BTreeMap<String, String>,
    creator_boot_id: String,
    started_monotonic_ns: u64,
    completed_monotonic_ns: u64,
    started_unix_ns: u128,
    completed_unix_ns: u128,
}

fn unique_snapshot_files<'de, D>(deserializer: D) -> Result<BTreeMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Unique;
    impl<'de> serde::de::Visitor<'de> for Unique {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("unique snapshot filenames and hashes")
        }
        fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
        where
            M: serde::de::MapAccess<'de>,
        {
            let mut result = BTreeMap::new();
            while let Some((name, hash)) = map.next_entry::<String, String>()? {
                if result.insert(name, hash).is_some() {
                    return Err(serde::de::Error::custom("duplicate snapshot filename"));
                }
            }
            Ok(result)
        }
    }
    deserializer.deserialize_map(Unique)
}

struct Creation {
    inputs: Inputs,
    paths: [PathBuf; 4],
    output: SnapshotOutputPaths,
    creator_boot_id: String,
    started_monotonic_ns: u64,
    started_unix_ns: u128,
}

impl Creation {
    fn capture(config: &SnapshotCreateConfig, source: &str, producer: &Path) -> TestResult<Self> {
        match std::fs::symlink_metadata(&config.output_dir) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => {
                return Err(io::Error::other(
                    "snapshot preparation requires a new output directory",
                )
                .into());
            }
        }
        let profile = Profile {
            vcpu: config.vcpu_count,
            memory_mib: config.memory_mb,
            home_mib: config.home_disk_mb,
        };
        if profile != Profile::native()
            || source.len() != 40
            || !source
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            || config.id.is_empty()
            || config.id.len() > 70
            || matches!(config.id.as_str(), "." | "..")
            || !config
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        {
            return Err(io::Error::other("invalid native snapshot preparation inputs").into());
        }
        let (started_monotonic_ns, started_unix_ns) = clocks()?;
        let creator_boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?
            .trim()
            .to_owned();
        let paths = [
            producer.to_path_buf(),
            config.binary_path.clone(),
            config.kernel_path.clone(),
            config.rootfs_path.clone(),
        ];
        let inputs = Inputs {
            source_sha: source.to_owned(),
            producer_test_binary_sha256: file_sha256(&paths[0])?,
            firecracker_sha256: file_sha256(&paths[1])?,
            kernel_sha256: file_sha256(&paths[2])?,
            rootfs_sha256: file_sha256(&paths[3])?,
            snapshot_id: config.id.clone(),
            profile,
        };
        Ok(Self {
            inputs,
            paths,
            output: SnapshotOutputPaths::new(config.output_dir.clone()),
            creator_boot_id,
            started_monotonic_ns,
            started_unix_ns,
        })
    }

    fn publish(self) -> TestResult<()> {
        let marker = read_regular(
            &self.output.complete_marker(),
            SNAPSHOT_COMPLETE_MARKER_CONTENT.len() as u64,
        )?;
        if marker != SNAPSHOT_COMPLETE_MARKER_CONTENT {
            return Err(
                io::Error::other("snapshot preparation has an invalid completion marker").into(),
            );
        }
        let mut snapshot_files = BTreeMap::new();
        for path in self
            .output
            .required_artifacts()
            .into_iter()
            .chain([self.output.complete_marker()])
        {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| io::Error::other("invalid snapshot filename"))?;
            let hash = if path == self.output.complete_marker() {
                // Hash the same bounded bytes whose exact marker was checked.
                hex::encode(Sha256::digest(&marker))
            } else {
                file_sha256(&path)?
            };
            snapshot_files.insert(name.to_owned(), hash);
        }
        for (path, expected) in self.paths.iter().zip([
            &self.inputs.producer_test_binary_sha256,
            &self.inputs.firecracker_sha256,
            &self.inputs.kernel_sha256,
            &self.inputs.rootfs_sha256,
        ]) {
            if file_sha256(path)? != *expected {
                return Err(
                    io::Error::other("snapshot preparation input changed during creation").into(),
                );
            }
        }
        let (completed_monotonic_ns, completed_unix_ns) = clocks()?;
        let record = Record {
            format: FORMAT.to_owned(),
            inputs: self.inputs,
            snapshot_files,
            creator_boot_id: self.creator_boot_id,
            started_monotonic_ns: self.started_monotonic_ns,
            completed_monotonic_ns,
            started_unix_ns: self.started_unix_ns,
            completed_unix_ns,
        };
        let mut temporary = tempfile::NamedTempFile::new_in(self.output.dir())?;
        serde_json::to_writer_pretty(&mut temporary, &record)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        let path = self.output.dir().join(RECORD_FILE);
        temporary.persist_noclobber(&path)?;
        if let Err(error) = File::open(self.output.dir()).and_then(|directory| directory.sync_all())
        {
            std::fs::remove_file(&path).map_err(|cleanup| {
                io::Error::other(format!(
                    "snapshot preparation publication uncertain: {error}; removal failed: {cleanup}"
                ))
            })?;
            return Err(error.into());
        }
        Ok(())
    }
}

pub(super) async fn prepare(config: SnapshotCreateConfig) -> TestResult<()> {
    let creation = Creation::capture(&config, compiled_source()?, &std::env::current_exe()?)?;
    sandbox_firecracker::create_snapshot(config).await?;
    creation.publish()
}

fn read_regular(path: &Path, limit: u64) -> TestResult<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.file_type().is_file() {
        return Err(io::Error::other("snapshot preparation evidence is not a regular file").into());
    }
    let mut content = Vec::new();
    file.take(limit + 1).read_to_end(&mut content)?;
    if content.len() as u64 > limit {
        return Err(
            io::Error::other("snapshot preparation evidence exceeds its byte bound").into(),
        );
    }
    Ok(content)
}

pub(super) fn verify_record(directory: &Path, artifacts: &Artifacts) -> TestResult<()> {
    let raw = read_regular(&directory.join(RECORD_FILE), MAX_RECORD_BYTES)?;
    if hex::encode(Sha256::digest(&raw)) != artifacts.snapshot_preparation_sha256 {
        return Err(io::Error::other("snapshot preparation record hash mismatch").into());
    }
    let record: Record = serde_json::from_slice(&raw)?;
    let expected = Inputs {
        source_sha: artifacts.source_sha.clone(),
        producer_test_binary_sha256: artifacts.test_binary_sha256.clone(),
        firecracker_sha256: artifacts.firecracker_sha256.clone(),
        kernel_sha256: artifacts.kernel_sha256.clone(),
        rootfs_sha256: artifacts.rootfs_sha256.clone(),
        snapshot_id: artifacts.snapshot_id.clone(),
        profile: Profile::native(),
    };
    if record.format != FORMAT
        || record.inputs != expected
        || record.snapshot_files != artifacts.snapshot_files
        || record.snapshot_files.len() != 5
        || record.started_monotonic_ns == 0
        || record.completed_monotonic_ns <= record.started_monotonic_ns
        || record.started_unix_ns == 0
        || record.completed_unix_ns == 0
        || uuid::Uuid::parse_str(&record.creator_boot_id)?.to_string() != record.creator_boot_id
    {
        return Err(io::Error::other("snapshot preparation input/output binding mismatch").into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
