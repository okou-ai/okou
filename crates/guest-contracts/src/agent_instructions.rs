//! Apply an instruction file already delivered by the ordinary Storage plan.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Bound instruction control input independently of file bytes.
pub const MAX_METADATA_BYTES: usize = 4 * 1024;
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
        // agy loads this file as its global rules for every workspace.
        "antigravity" => ".gemini/GEMINI.md",
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

/// Inspect the managed file and any startup roots needed for reuse.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstructionCheck {
    /// Framework discriminator.
    pub framework: String,
    /// Observe the selected framework's canonical Memory root when Instructions can be reused.
    #[serde(default)]
    pub check_memory_root: bool,
}

/// Reuse observations from the bounded Guest Instructions helper.
#[derive(Serialize, Deserialize)]
pub struct InstructionCheckResult {
    /// The local Instructions file can be preserved.
    pub instructions_current: bool,
    /// A requested Memory directory was present during this check.
    pub memory_root_present: bool,
}
