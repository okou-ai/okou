//! Immutable redistribution access; no worker, credential or native context runs.
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
#[test]
fn exports_build_selected_helper_and_complete_notices_without_opening_a_context() {
    use sha2::{Digest, Sha256};
    let package = kerberos_worker::native_package().expect("supported Linux package must export");
    assert_eq!(&package.helper[..4], b"\x7fELF");
    assert!(!package.helper.is_empty() && package.helper.len() <= 16 * 1024 * 1024);
    assert_eq!(package.notices, kerberos_worker::NATIVE_NOTICES);
    assert_eq!(
        package.target,
        format!("{}-unknown-linux-musl", std::env::consts::ARCH)
    );
    assert_eq!(
        Sha256::digest(package.helper)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
        package.helper_sha256
    );
    assert_eq!(
        Sha256::digest(package.notices.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
        package.notices_sha256
    );
}
