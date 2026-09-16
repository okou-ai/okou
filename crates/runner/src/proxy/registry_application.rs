//! Publication evidence is separate from the addon's point-in-time application.

use std::io;
use std::net::IpAddr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::info;

use super::control::{self, ControlTarget};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub(super) struct RegistryDigest(String);

impl RegistryDigest {
    pub fn of(bytes: &[u8]) -> Self {
        Self(hex::encode(Sha256::digest(bytes)))
    }
}

impl TryFrom<String> for RegistryDigest {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            Ok(Self(value))
        } else {
            Err("invalid registry digest")
        }
    }
}

#[derive(Debug)]
pub struct RegistryPublication {
    pub(super) digest: RegistryDigest,
    pub(super) target: Option<ControlTarget>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileIdentity {
    device: u64,
    inode: u64,
    mtime_ns: i64,
    size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum CatalogSnapshot {
    NotUsed,
    Available {
        file: FileIdentity,
        digest: RegistryDigest,
    },
    Unavailable {
        file: Option<FileIdentity>,
        reason: CatalogUnavailableReason,
    },
}

#[derive(Debug, Deserialize, Serialize)]
enum CatalogUnavailableReason {
    #[serde(rename = "cache_path_missing")]
    PathMissing,
    #[serde(rename = "cache_file_missing")]
    FileMissing,
    #[serde(rename = "cache_permission_denied")]
    PermissionDenied,
    #[serde(rename = "cache_not_regular")]
    NotRegular,
    #[serde(rename = "cache_untrusted")]
    Untrusted,
    #[serde(rename = "cache_unavailable")]
    Unavailable,
    #[serde(rename = "cache_invalid")]
    Invalid,
}

#[derive(Debug, Deserialize, Serialize)]
enum RegistryUnavailableReason {
    #[serde(rename = "stat_failed")]
    Stat,
    #[serde(rename = "read_failed")]
    Read,
    #[serde(rename = "parse_failed")]
    Parse,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntryOutcome {
    source_ip: Option<IpAddr>,
    reason: EntryReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    builtin_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_count: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum EntryReason {
    InvalidSandboxEntry,
    MissingRunId,
    InvalidRunId,
    EmptyRunId,
    InvalidBillableFirewalls,
    MissingCliAgentType,
    InvalidCliAgentType,
    EmptyCliAgentType,
    InvalidFirewalls,
    InvalidOmittedIntents,
    InvalidConnectorRoutingVariables,
    OmittedIntents,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum RegistrySnapshot {
    Unobserved,
    Unavailable {
        digest: Option<RegistryDigest>,
        file: Option<FileIdentity>,
        reason: RegistryUnavailableReason,
    },
    Available {
        digest: RegistryDigest,
        file: FileIdentity,
        catalog: CatalogSnapshot,
        #[serde(rename = "validEntries")]
        valid_entries: u64,
        #[serde(rename = "rejectedEntries")]
        rejected_entries: u64,
        #[serde(rename = "omittedEntries")]
        omitted_entries: u64,
        entries: Vec<EntryOutcome>,
        truncated: bool,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ApplicationState {
    Applied,
    Superseded,
    Rejected,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplicationReceipt {
    expected_digest: RegistryDigest,
    state: ApplicationState,
    snapshot: RegistrySnapshot,
}

impl ApplicationReceipt {
    fn validate(&self, expected: &RegistryDigest) -> io::Result<()> {
        let coherent = self.expected_digest == *expected
            && match (&self.state, &self.snapshot) {
                (ApplicationState::Rejected, RegistrySnapshot::Unavailable { .. }) => true,
                (
                    ApplicationState::Applied | ApplicationState::Superseded,
                    RegistrySnapshot::Available {
                        digest,
                        rejected_entries,
                        omitted_entries,
                        valid_entries,
                        entries,
                        truncated,
                        ..
                    },
                ) => {
                    let total = rejected_entries.checked_add(*omitted_entries);
                    let outcomes_valid = entries.iter().all(|entry| match entry.reason {
                        EntryReason::OmittedIntents => entry
                            .builtin_count
                            .zip(entry.custom_count)
                            .is_some_and(|(builtin, custom)| builtin > 0 || custom > 0),
                        _ => entry.builtin_count.is_none() && entry.custom_count.is_none(),
                    });
                    matches!(self.state, ApplicationState::Applied) == (digest == expected)
                        && omitted_entries <= valid_entries
                        && entries.len() <= 32
                        && total.is_some_and(|total| {
                            entries.len() as u64 == total.min(32) && *truncated == (total > 32)
                        })
                        && outcomes_valid
                }
                _ => false,
            };
        if coherent {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "incoherent registry application receipt",
            ))
        }
    }
}

impl RegistryPublication {
    async fn apply(&self) -> io::Result<ApplicationReceipt> {
        let target = self.target.as_ref().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotConnected, "addon control is unavailable")
        })?;
        let result: ApplicationReceipt = control::exchange(
            &target.directory,
            &target.generation,
            "registry.apply",
            serde_json::json!({"digest": self.digest}),
            tokio::time::Instant::now() + Duration::from_secs(5),
        )
        .await?;
        result.validate(&self.digest)?;
        Ok(result)
    }

    /// Observe after releasing publication/registration locks. A missing reply
    /// does not undo publication, establish rejection, or authorize replay.
    pub async fn observe(&self) {
        if self.target.is_none() {
            return;
        }
        match self.apply().await {
            Ok(receipt) => info!(
                registry_digest = %self.digest.0,
                application = ?receipt,
                "observed addon registry application"
            ),
            Err(error) => info!(
                registry_digest = %self.digest.0,
                %error,
                "registry published; addon application outcome not confirmed"
            ),
        }
    }
}

#[cfg(test)]
mod tests;
