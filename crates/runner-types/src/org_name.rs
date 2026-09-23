//! Validation for runner `org/name` identifiers.
//!
//! Mirrors the `/^[a-z0-9-]+\/[a-z0-9-]+$/` contract in:
//! - `turbo/packages/api-contracts/src/contracts/runners.ts`
//!
//! Keep the Rust and TypeScript contracts in sync.

/// Return whether `name` contains exactly two non-empty slash-separated
/// components made of lowercase ASCII letters, digits, or hyphens.
pub fn is_valid(name: &str) -> bool {
    let Some((org, resource_name)) = name.split_once('/') else {
        return false;
    };
    if org.is_empty() || resource_name.is_empty() || resource_name.contains('/') {
        return false;
    }

    let valid_part = |part: &str| {
        part.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    valid_part(org) && valid_part(resource_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_contract_language() {
        for name in [
            "vm0/prod",
            "test/group",
            "acme/my-resource-1",
            "123/456",
            "-vm0/prod",
            "vm0/prod-",
            "-/--",
        ] {
            assert!(is_valid(name), "expected {name:?} to be valid");
        }
    }

    #[test]
    fn rejects_names_outside_contract_language() {
        for name in [
            "",
            "default",
            "/default",
            "vm0/",
            "vm0/my/nested",
            "VM0/prod",
            "vm0/Prod",
            "vm0/pr od",
            "vm0/prod_1",
            "vm0/pröd",
            "组织/prod",
            "..",
            "../etc",
            "vm0/../etc",
            "/etc",
            "/etc/passwd",
            ".",
            "vm0/.",
            "vm0/..",
            r"vm0\prod",
        ] {
            assert!(!is_valid(name), "expected {name:?} to be invalid");
        }
    }
}
