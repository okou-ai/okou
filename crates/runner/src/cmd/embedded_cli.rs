#[cfg(not(bundled_okou_cli))]
use crate::error::RunnerError;
use crate::error::RunnerResult;

/// The same compiled-in byte resource pattern as the Guest binaries. The
/// rootfs installer can consume this accessor in the later cutover slice.
#[cfg(bundled_okou_cli)]
pub(crate) fn package() -> &'static [u8] {
    include_bytes!(env!("BUNDLED_OKOU_CLI_PACKAGE"))
}

/// Inspect the identity selected at compile time, including cache hits. The
/// package is immutable once embedded; this command does not rehash it.
pub fn run_embedded_cli_info() -> RunnerResult<()> {
    #[cfg(bundled_okou_cli)]
    {
        // Keep the entire package linked even before rootfs installation uses
        // the accessor. Reading only a const length could elide the bytes.
        let package = std::hint::black_box(package());
        println!(
            "{}",
            serde_json::json!({
                "sourceSha": env!("BUNDLED_OKOU_CLI_SOURCE_SHA"),
                "packageSha256": env!("BUNDLED_OKOU_CLI_SHA256"),
                "packageSizeBytes": package.len(),
            })
        );
        Ok(())
    }
    #[cfg(not(bundled_okou_cli))]
    {
        Err(RunnerError::Internal(
            "Runner was built without an embedded CLI".into(),
        ))
    }
}
