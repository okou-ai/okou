use guest_contracts::env::{CliAgentTypeSelection, CliFramework};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum EffectiveCliFramework {
    ClaudeCode,
    Codex,
    Pi,
}

impl From<CliFramework> for EffectiveCliFramework {
    fn from(framework: CliFramework) -> Self {
        match framework {
            CliFramework::ClaudeCode => Self::ClaudeCode,
            CliFramework::Codex => Self::Codex,
            CliFramework::Pi => Self::Pi,
        }
    }
}

impl From<EffectiveCliFramework> for CliFramework {
    fn from(framework: EffectiveCliFramework) -> Self {
        match framework {
            EffectiveCliFramework::ClaudeCode => Self::ClaudeCode,
            EffectiveCliFramework::Codex => Self::Codex,
            EffectiveCliFramework::Pi => Self::Pi,
        }
    }
}

pub(crate) fn effective_cli_framework(cli_agent_type: &str) -> EffectiveCliFramework {
    CliAgentTypeSelection::parse(cli_agent_type)
        .framework()
        .into()
}

pub(super) fn normalized_cli_agent_type(cli_agent_type: &str) -> &str {
    CliAgentTypeSelection::parse(cli_agent_type).normalized_cli_agent_type()
}
