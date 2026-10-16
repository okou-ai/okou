//! Immutable redistribution access; no worker, credential or native context runs.
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
#[test]
fn concurrent_exports_keep_build_selected_helper_and_complete_notices_without_opening_a_context() {
    use sha2::{Digest, Sha256};
    use std::{sync::Barrier, thread};

    let gate = Barrier::new(8);
    let packages = thread::scope(|scope| {
        let callers: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    gate.wait();
                    kerberos_worker::native_package().expect("supported Linux package must export")
                })
            })
            .collect();
        callers
            .into_iter()
            .map(|caller| caller.join().unwrap())
            .collect::<Vec<_>>()
    });
    let package = &packages[0];
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
    let repeated = kerberos_worker::native_package().unwrap();
    for other in packages.iter().skip(1).chain(std::iter::once(&repeated)) {
        assert!(other.helper == package.helper);
        assert_eq!(other.helper_sha256, package.helper_sha256);
        assert_eq!(other.notices, package.notices);
        assert_eq!(other.notices_sha256, package.notices_sha256);
        assert_eq!(other.target, package.target);
    }
}
