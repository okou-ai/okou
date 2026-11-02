//! Third-party dependency metadata: versions, checksums, and download URLs.

pub const FIRECRACKER_VERSION: &str = "v1.16.2";
pub const KERNEL_VERSION: &str = "6.18.44";
/// Canonical mitmproxy release for runner artifacts and the embedded add-on.
pub const MITMPROXY_VERSION: &str = "12.3.0";

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
pub const MITMDUMP_SIZE_X86_64: u64 = 34_305_904;
pub const MITMDUMP_SIZE_AARCH64: u64 = 32_495_056;
pub const MITMDUMP_SHA256_X86_64: &str =
    "edb61120fe1496f649bb95ac3186dc0dbb3ef06e25758ea3cfce7bf91f8ebac9";
pub const MITMDUMP_SHA256_AARCH64: &str =
    "3adf33868f5477ff65d954b3fbe5dc5eca9703b5f02692500e880b8789caccb1";

// Exact identities for compressed source archives, keyed by arch.
pub const FIRECRACKER_ARCHIVE_SIZE_X86_64: u64 = 7_499_848;
pub const FIRECRACKER_ARCHIVE_SIZE_AARCH64: u64 = 7_321_444;
pub const FIRECRACKER_ARCHIVE_SHA256_X86_64: &str =
    "32e3cdcd4081f91fe2b024a266f57dcb3b4e5fec5033e0cb22467ad7f7820bda";
pub const FIRECRACKER_ARCHIVE_SHA256_AARCH64: &str =
    "751365040ca3dde7616c5a1d97cc1304674fae469ce02993104eab22f5961950";
pub const MITMPROXY_ARCHIVE_SIZE_X86_64: u64 = 104_087_608;
pub const MITMPROXY_ARCHIVE_SIZE_AARCH64: u64 = 98_927_179;
pub const MITMPROXY_ARCHIVE_SHA256_X86_64: &str =
    "d52bacb30012023c7e920f322a97a6bc3b0553a7944b520e9aa02278c910b938";
pub const MITMPROXY_ARCHIVE_SHA256_AARCH64: &str =
    "f8756fa831c4abe431dd922ae7291b158b465285562b35d12e5669cbfc29d1f3";

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

#[cfg(test)]
mod tests;
