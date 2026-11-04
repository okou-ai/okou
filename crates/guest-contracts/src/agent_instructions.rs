//! Apply an instruction file already delivered by the ordinary Storage plan.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Bound the small instruction-application control input independently of file bytes.
pub const MAX_METADATA_BYTES: usize = 4 * 1024;
/// Bound a path-aware reuse check by the existing Guest exec stdin envelope.
pub const MAX_CHECK_METADATA_BYTES: usize = 64 * 1024;
/// Canonical instruction package member, independent of the target framework.
pub const SOURCE_FILENAME: &str = "instructions.md";

/// Fixed instruction-helper actions; callers cannot select a program or identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstructionOperation {
    /// Inspect whether the final instruction file can be retained.
    Check,
    /// Publish the instruction file already delivered to staging.
    Apply,
}

impl InstructionOperation {
    /// Maximum opaque metadata bytes for this action.
    pub const fn metadata_limit(self) -> usize {
        match self {
            Self::Check => MAX_CHECK_METADATA_BYTES,
            Self::Apply => MAX_METADATA_BYTES,
        }
    }

    /// Fixed argument selected by the Guest, never caller command text.
    pub const fn helper_argument(self) -> &'static str {
        match self {
            Self::Check => "--instructions-check-stdin",
            Self::Apply => "--instructions-stdin",
        }
    }
}

/// Stable delivery and final-file paths for one framework.
pub struct InstructionPaths {
    /// Ordinary Storage staging; removed after successful application.
    pub staging: PathBuf,
    /// Managed file whose presence is required for same-version reuse.
    pub target: PathBuf,
}

/// Resolve only supported framework targets without performing filesystem IO.
pub fn instruction_paths(home: &Path, framework: &str) -> Option<InstructionPaths> {
    let target = match framework {
        "claude-code" => ".claude/CLAUDE.md",
        "codex" => ".codex/AGENTS.md",
        "pi" => ".pi/agent/AGENTS.md",
        _ => return None,
    };
    Some(InstructionPaths {
        staging: home.join(".vm0/agent-instructions").join(framework),
        target: home.join(target),
    })
}

/// Select the managed framework file and its ordinary Storage staging.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstructionApplication {
    /// Framework discriminator.
    pub framework: String,
}

/// Inspect the managed file and mutable mounts whose existing roots survive cleanup.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstructionCheck {
    /// Framework discriminator.
    pub framework: String,
    /// Downloads below cached mounts can retain symlinks to the managed target.
    #[serde(default)]
    pub preserved_download_mounts: Vec<String>,
}
