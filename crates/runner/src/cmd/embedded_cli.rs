/// The same compiled-in byte resource pattern as the Guest binaries. The
/// rootfs installer stages these exact bytes for local installation.
#[cfg(bundled_okou_cli)]
pub(crate) fn package() -> &'static [u8] {
    include_bytes!(env!("BUNDLED_OKOU_CLI_PACKAGE"))
}
