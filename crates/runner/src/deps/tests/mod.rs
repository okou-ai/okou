use super::*;

const MITMPROXY_COMPAT_SOURCE: &str = include_str!("../../../mitm-addon/src/mitmproxy_compat.py");
const MITM_ADDON_PYPROJECT: &str = include_str!("../../../mitm-addon/pyproject.toml");

fn quoted_values<'a>(source: &'a str, prefix: &str, suffix: &str) -> Vec<&'a str> {
    source
        .lines()
        .filter_map(|line| line.strip_prefix(prefix)?.strip_suffix(suffix))
        .collect()
}

#[test]
fn url_functions_include_arch() {
    // Verify arch substitution works (not just substring presence)
    assert_ne!(firecracker_url("x86_64"), firecracker_url("aarch64"));
    assert_ne!(kernel_url("x86_64"), kernel_url("aarch64"));
    assert_ne!(mitmdump_url("x86_64"), mitmdump_url("aarch64"));
    assert_ne!(
        firecracker_tar_entry("x86_64"),
        firecracker_tar_entry("aarch64")
    );
}

#[test]
fn sha256_checksums_are_valid_hex() {
    for sha in [
        FIRECRACKER_SHA256_X86_64,
        FIRECRACKER_SHA256_AARCH64,
        FIRECRACKER_ARCHIVE_SHA256_X86_64,
        FIRECRACKER_ARCHIVE_SHA256_AARCH64,
        KERNEL_SHA256_X86_64,
        KERNEL_SHA256_AARCH64,
        MITMDUMP_SHA256_X86_64,
        MITMDUMP_SHA256_AARCH64,
        MITMPROXY_ARCHIVE_SHA256_X86_64,
        MITMPROXY_ARCHIVE_SHA256_AARCH64,
    ] {
        assert_eq!(sha.len(), 64, "SHA256 hex should be 64 chars: {sha}");
        assert!(
            sha.chars().all(|c| c.is_ascii_hexdigit()),
            "SHA256 should be valid hex: {sha}"
        );
    }
}

#[test]
fn mitmproxy_version_contract_matches_python_runtime_and_tests() {
    let runtime_versions = quoted_values(
        MITMPROXY_COMPAT_SOURCE,
        "_SUPPORTED_MITMPROXY_VERSION = \"",
        "\"",
    );
    assert_eq!(
        runtime_versions.as_slice(),
        &[MITMPROXY_VERSION],
        "mitmproxy runtime guard must contain exactly one version matching MITMPROXY_VERSION"
    );

    let test_versions = quoted_values(MITM_ADDON_PYPROJECT, "    \"mitmproxy==", "\",");
    assert_eq!(
        test_versions.as_slice(),
        &[MITMPROXY_VERSION],
        "mitmproxy test dependencies must contain exactly one version matching MITMPROXY_VERSION"
    );
}
