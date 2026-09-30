use super::fixtures::*;
use super::*;
use clap::CommandFactory;
use std::any::TypeId;
use std::collections::BTreeSet;
use std::path::PathBuf;

#[test]
fn build_args_parse_warm_rootfs_cache_flag() {
    let mut args = build_args();
    args.push("--warm-rootfs-cache".to_string());

    let cli = <TestBuildCli as clap::Parser>::try_parse_from(args).unwrap();

    assert!(cli.args.warm_rootfs_cache);
    assert!(!cli.args.dry_run);
    assert_eq!(BuildMode::from_args(&cli.args), BuildMode::WarmRootfsCache);
}

#[test]
fn build_args_parse_warm_rootfs_cache_without_guest_binaries() {
    let mut cli = <TestBuildCli as clap::Parser>::try_parse_from([
        "runner-build",
        "--profile",
        "vm0/default",
        "--warm-rootfs-cache",
    ])
    .unwrap();

    assert_eq!(BuildMode::from_args(&cli.args), BuildMode::WarmRootfsCache);
    for definition in guest_definitions() {
        assert!(cli.args.take_guest_path(definition.name).is_none());
    }
}

#[test]
fn build_args_reject_dry_run_with_warm_rootfs_cache() {
    let mut args = build_args();
    args.extend(["--dry-run".to_string(), "--warm-rootfs-cache".to_string()]);

    let error = <TestBuildCli as clap::Parser>::try_parse_from(args)
        .err()
        .expect("combined flags should fail");

    assert_eq!(error.kind(), clap::error::ErrorKind::ArgumentConflict);
}

#[test]
fn build_help_describes_dry_run_and_warm_cache_output() {
    let help = TestBuildCli::command().render_help().to_string();
    let normalized_help = help.split_whitespace().collect::<Vec<_>>().join(" ");

    assert!(normalized_help.contains(
        "Print rootfs_hash and snapshot_hash without building (incompatible with --warm-rootfs-cache)"
    ));
    assert!(normalized_help.contains(
        "Populate only the shared R2 template cache; prints no image hashes (incompatible with --dry-run)"
    ));
}

#[test]
fn guest_cli_flags_match_inventory() {
    let command = TestBuildCli::command();
    let actual: BTreeSet<_> = command
        .get_arguments()
        .filter(|arg| arg.get_value_parser().type_id() == TypeId::of::<PathBuf>())
        .filter_map(|arg| arg.get_long())
        .map(str::to_owned)
        .collect();
    let expected: BTreeSet<_> = guest_definitions()
        .iter()
        .map(|definition| definition.name.to_string())
        .collect();

    assert_eq!(actual, expected);
}

#[tokio::test]
async fn explicit_guest_paths_resolve_every_inventory_entry() {
    let source_dir = tempfile::tempdir().unwrap();
    let mut argv = vec!["runner-build".to_string()];
    for definition in guest_definitions() {
        let source = source_dir.path().join(definition.name);
        std::fs::write(&source, definition.name).unwrap();
        argv.push(format!("--{}", definition.name));
        argv.push(source.to_string_lossy().into_owned());
    }
    argv.extend(["--profile".to_string(), "vm0/default".to_string()]);

    let mut cli = <TestBuildCli as clap::Parser>::try_parse_from(argv).unwrap();
    let guests = GuestBinaries::resolve(&mut cli.args).await.unwrap();

    assert_eq!(guests.entries.len(), guest_definitions().len());
    for guest in guests.iter() {
        assert_eq!(
            std::fs::read_to_string(&guest.path).unwrap(),
            guest.definition.name
        );
    }
}

#[test]
fn build_mode_defaults_to_full_image() {
    let cli = <TestBuildCli as clap::Parser>::try_parse_from(build_args()).unwrap();

    assert_eq!(BuildMode::from_args(&cli.args), BuildMode::FullImage);
}

#[test]
fn required_warm_cache_requires_r2_config() {
    let err = TemplateCache::from_optional(BuildMode::WarmRootfsCache, None).unwrap_err();

    assert!(
        err.to_string()
            .contains("--warm-rootfs-cache requires all R2_*")
    );
}
