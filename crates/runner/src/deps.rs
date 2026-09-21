//! Third-party dependency metadata: versions, checksums, and download URLs.

pub const FIRECRACKER_VERSION: &str = "v1.16.2";
pub const KERNEL_VERSION: &str = "6.18.44";
/// Canonical mitmproxy release for runner artifacts and the embedded add-on.
pub const MITMPROXY_VERSION: &str = "12.2.3";

// Exact identities for installed artifacts, keyed by arch.
pub const FIRECRACKER_SIZE_X86_64: u64 = 3_539_456;
pub const FIRECRACKER_SIZE_AARCH64: u64 = 3_255_464;
pub const FIRECRACKER_SHA256_X86_64: &str =
    "8227875ceda44177a4d501052dae4a2f9d7837362f5399f02cf0748e68418377";
pub const FIRECRACKER_SHA256_AARCH64: &str =
    "f7168507c37b2b047ea2b30433cbe4faa3986c36d1209c046fd1814118ce3d48";
pub const KERNEL_SIZE_X86_64: u64 = 27_846_248;
pub const KERNEL_SIZE_AARCH64: u64 = 19_397_120;
pub const KERNEL_SHA256_X86_64: &str =
    "d8ced68bd61e27b6813e2c993cc53a4029c59e13210672180591c84109684fe4";
pub const KERNEL_SHA256_AARCH64: &str =
    "3b0233769ed8c89f1f47fdbcc4ff9300a2b1b5c618e25ade966a484481b151dc";
pub const MITMDUMP_SIZE_X86_64: u64 = 39_172_624;
pub const MITMDUMP_SIZE_AARCH64: u64 = 36_908_488;
pub const MITMDUMP_SHA256_X86_64: &str =
    "8466d978a58317cd267b91a9dae84b0c4fb630c299515849a52744d34e9e04cf";
pub const MITMDUMP_SHA256_AARCH64: &str =
    "47612c592db3b0b80164aee2dd1be1f3841d5430891f7ebeabf2284a7cc490b9";

// Exact identities for compressed source archives, keyed by arch.
pub const FIRECRACKER_ARCHIVE_SIZE_X86_64: u64 = 7_499_848;
pub const FIRECRACKER_ARCHIVE_SIZE_AARCH64: u64 = 7_321_444;
pub const FIRECRACKER_ARCHIVE_SHA256_X86_64: &str =
    "32e3cdcd4081f91fe2b024a266f57dcb3b4e5fec5033e0cb22467ad7f7820bda";
pub const FIRECRACKER_ARCHIVE_SHA256_AARCH64: &str =
    "751365040ca3dde7616c5a1d97cc1304674fae469ce02993104eab22f5961950";
pub const MITMPROXY_ARCHIVE_SIZE_X86_64: u64 = 119_209_168;
pub const MITMPROXY_ARCHIVE_SIZE_AARCH64: u64 = 112_694_307;
pub const MITMPROXY_ARCHIVE_SHA256_X86_64: &str =
    "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5";
pub const MITMPROXY_ARCHIVE_SHA256_AARCH64: &str =
    "b358643a6c4f4b39e33d985350f660b724fece95687d7daa899ef0c4e211f681";

/// System CA certificate bundle path. The standalone mitmproxy binary bundles its
/// own (incomplete) certifi CA store; we override it with the host's system store.
pub const SYSTEM_CA_BUNDLE: &str = "/etc/ssl/certs/ca-certificates.crt";

/// Tarball entry name for firecracker binary.
pub fn firecracker_tar_entry(arch: &str) -> String {
    format!("firecracker-{FIRECRACKER_VERSION}-{arch}")
}

pub fn firecracker_url(arch: &str) -> String {
    format!(
        "https://github.com/firecracker-microvm/firecracker/releases/download/{FIRECRACKER_VERSION}/firecracker-{FIRECRACKER_VERSION}-{arch}.tgz"
    )
}

pub fn kernel_url(arch: &str) -> String {
    // Pin a dated upstream Amazon Linux microVM kernel build independently of
    // the VMM version. Guest 6.18 is supported with Firecracker >= v1.16.1:
    // https://github.com/firecracker-microvm/firecracker/blob/main/docs/kernel-policy.md#guest-kernel
    format!(
        "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20260909-a8e1c3830545-0/{arch}/vmlinux-{KERNEL_VERSION}"
    )
}

/// Tarball entry name for mitmdump binary.
pub const MITMDUMP_TAR_ENTRY: &str = "mitmdump";

pub fn mitmdump_url(arch: &str) -> String {
    format!(
        "https://downloads.mitmproxy.org/{MITMPROXY_VERSION}/mitmproxy-{MITMPROXY_VERSION}-linux-{arch}.tar.gz"
    )
}

runner_test_group!(platform_support; #[cfg(test)]
mod tests {
    use super::*;

    const MITMPROXY_COMPAT_SOURCE: &str = include_str!("../mitm-addon/src/mitmproxy_compat.py");
    const MITM_ADDON_PYPROJECT: &str = include_str!("../mitm-addon/pyproject.toml");

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
});
