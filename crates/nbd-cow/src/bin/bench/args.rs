pub(crate) const DEFAULT_BASE_SIZE_MB: u64 = 1024;
// The largest fio workload writes 512 MiB. dm-snapshot COW needs extra space
// for metadata, so keep the minimum at the default 1 GiB instead of 512 MiB.
pub(crate) const MIN_BASE_SIZE_MB: u64 = DEFAULT_BASE_SIZE_MB;

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum BenchCommand {
    Run { base_size_mb: u64 },
    Help,
}

pub(crate) fn parse_bench_args(args: &[String]) -> Result<BenchCommand, String> {
    match args {
        [] => Ok(BenchCommand::Run {
            base_size_mb: DEFAULT_BASE_SIZE_MB,
        }),
        [flag] if flag == "-h" || flag == "--help" => Ok(BenchCommand::Help),
        [value] => value
            .parse::<u64>()
            .map(|base_size_mb| BenchCommand::Run { base_size_mb })
            .map_err(|e| format!("invalid base image size {value:?}: {e}")),
        _ => Err(usage().to_string()),
    }
}

pub(crate) fn usage() -> &'static str {
    "NBD COW vs dm-snapshot benchmark\n\n\
Usage:\n  cargo run --manifest-path crates/Cargo.toml -p nbd-cow --features bench --bin bench -- [base-size-mb]\n\n\
Arguments:\n  [base-size-mb]  Base image size in MB (default: 1024 MB; inclusive minimum: 1024 MB)\n\n\
Requirements:\n  - Run as root.\n  - fio, losetup, and dmsetup must be available on PATH.\n  - The NBD kernel module must be loaded:\n    modprobe nbd nbds_max=4096"
}

pub(crate) fn base_size_bytes(base_size_mb: u64) -> Option<u64> {
    if base_size_mb < MIN_BASE_SIZE_MB {
        return None;
    }
    base_size_mb.checked_mul(1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_bench_args_accepts_help_and_rejects_invalid_args() {
        assert_eq!(
            parse_bench_args(&[]).unwrap(),
            BenchCommand::Run {
                base_size_mb: DEFAULT_BASE_SIZE_MB
            }
        );
        assert_eq!(
            parse_bench_args(&["2048".to_string()]).unwrap(),
            BenchCommand::Run { base_size_mb: 2048 }
        );
        assert_eq!(
            parse_bench_args(&["--help".to_string()]).unwrap(),
            BenchCommand::Help
        );

        let invalid = parse_bench_args(&["abc".to_string()]).unwrap_err();
        assert!(invalid.contains("invalid base image size"), "{invalid}");

        let extra = parse_bench_args(&["1024".to_string(), "extra".to_string()]).unwrap_err();
        assert!(extra.contains("Usage:"), "{extra}");
    }

    #[test]
    fn usage_describes_benchmark_invocation_and_prerequisites() {
        let help = usage();

        for expected in [
            "NBD COW vs dm-snapshot benchmark",
            "cargo run --manifest-path crates/Cargo.toml -p nbd-cow --features bench --bin bench -- [base-size-mb]",
            "Base image size in MB",
            "default: 1024 MB",
            "inclusive minimum: 1024 MB",
            "Run as root",
            "fio, losetup, and dmsetup",
            "NBD kernel module",
            "modprobe nbd nbds_max=4096",
        ] {
            assert!(
                help.contains(expected),
                "missing {expected:?} from help: {help}"
            );
        }
    }

    #[test]
    fn base_size_bytes_rejects_too_small_values_and_overflow() {
        // The 512 MiB workload needs extra COW metadata space. Keep these values
        // independent of MIN_BASE_SIZE_MB so lowering the guard fails this test.
        assert_eq!(base_size_bytes(512), None);
        assert_eq!(base_size_bytes(1023), None);
        assert_eq!(base_size_bytes(1024), Some(1024 * 1024 * 1024));
        assert_eq!(base_size_bytes(0), None);
        assert_eq!(base_size_bytes(u64::MAX), None);
    }
}
