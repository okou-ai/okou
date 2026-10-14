//! The settled resource path shared by Runner, Guest completion and telemetry.

pub use api_contracts::generated::types::runners::SandboxStartupPath;

/// Canonical wire spelling for an already classified startup resource.
pub const fn as_wire(path: SandboxStartupPath) -> &'static str {
    match path {
        SandboxStartupPath::Sandbox => "sandbox",
        SandboxStartupPath::Home => "home",
        SandboxStartupPath::Blank => "blank",
        SandboxStartupPath::Cold => "cold",
    }
}
