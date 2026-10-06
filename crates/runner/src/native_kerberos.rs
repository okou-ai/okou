//! Public, offline redistribution access to this Runner's sealed native package.
//! This does not advertise a VNC capability or accept a helper/library override.
use std::io::Write;

#[derive(clap::Args)]
pub(crate) struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(clap::Subcommand)]
enum Command {
    /// Write the exact bundled helper ELF to stdout (binary output)
    Helper,
    /// Write the complete bundled MIT/musl/Zig redistribution notices to stdout
    Notices,
    /// Write the bundled package's target, digests and byte lengths as JSON
    Identity,
}

pub(crate) fn run(args: Args) -> crate::error::RunnerResult<()> {
    write_package(args.command, &mut std::io::stdout().lock()).map_err(|error| {
        crate::error::RunnerError::Internal(format!("native package export failed: {error}"))
    })
}

fn write_package(
    command: Command,
    output: &mut impl Write,
) -> Result<(), Box<dyn std::error::Error>> {
    let package = kerberos_worker::native_package()?;
    match command {
        Command::Helper => output.write_all(package.helper)?,
        Command::Notices => output.write_all(package.notices.as_bytes())?,
        Command::Identity => {
            serde_json::to_writer(
                &mut *output,
                &serde_json::json!({
                    "schemaVersion": 1,
                    "nativeTarget": package.target,
                    "helperSha256": package.helper_sha256,
                    "helperSizeBytes": package.helper.len(),
                    "noticesSha256": package.notices_sha256,
                    "noticesSizeBytes": package.notices.len(),
                }),
            )?;
            output.write_all(b"\n")?;
        }
    }
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn native_package_commands_are_discoverable_and_reject_overrides() {
        for command in ["helper", "notices", "identity"] {
            assert!(crate::Cli::try_parse_from(["runner", "native-kerberos", command]).is_ok());
            assert!(
                crate::Cli::try_parse_from([
                    "runner",
                    "native-kerberos",
                    command,
                    "--helper",
                    "/arbitrary/helper"
                ])
                .is_err()
            );
        }
    }

    #[test]
    fn exports_exact_bundled_bytes_and_identity_or_refuses_without_output() {
        let mut helper = Vec::new();
        let result = write_package(Command::Helper, &mut helper);
        let Ok(package) = kerberos_worker::native_package() else {
            assert!(result.is_err());
            assert!(helper.is_empty());
            return;
        };
        result.unwrap();
        assert_eq!(helper, package.helper);
        let mut notices = Vec::new();
        write_package(Command::Notices, &mut notices).unwrap();
        assert_eq!(notices, kerberos_worker::NATIVE_NOTICES.as_bytes());
        let mut identity = Vec::new();
        write_package(Command::Identity, &mut identity).unwrap();
        let identity: serde_json::Value = serde_json::from_slice(&identity).unwrap();
        assert_eq!(identity["nativeTarget"], package.target);
        assert_eq!(identity["helperSha256"], package.helper_sha256);
        assert_eq!(identity["helperSizeBytes"], helper.len());
        assert_eq!(identity["noticesSha256"], package.notices_sha256);
        assert_eq!(identity["noticesSizeBytes"], notices.len());
    }
}
