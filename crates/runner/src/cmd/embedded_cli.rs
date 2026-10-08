/// Package bytes snapshotted after build-time integrity and identity validation.
/// The rootfs installer stages these exact compiled resources.
#[cfg(bundled_okou_cli)]
pub(crate) fn package() -> &'static [u8] {
    include_bytes!(env!("BUNDLED_OKOU_CLI_PACKAGE"))
}

/// Installed metadata generated at compilation from the same verified package.
#[cfg(bundled_okou_cli)]
pub(crate) fn installed_manifest() -> &'static [u8] {
    include_bytes!(env!("BUNDLED_OKOU_CLI_INSTALLED_MANIFEST"))
}
