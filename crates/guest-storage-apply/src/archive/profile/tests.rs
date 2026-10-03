use super::fixtures::{CASES, Case, Fixture};
use super::{ACTIVE, PHASES, Phase, Profile, collect, scope};
use crate::archive::extract_tar_gz;
use crate::source::ArchiveSource;
use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::time::Instant;

#[test]
fn nested_scopes_account_for_children_and_restore_inactive_state() {
    let ((), profile) = collect(|| {
        let _outer = scope(Phase::Unpack);
        let _inner = scope(Phase::GzipRead);
    });
    let outer = profile.phases[Phase::Unpack as usize];
    let inner = profile.phases[Phase::GzipRead as usize];
    assert_eq!(outer.calls, 1);
    assert_eq!(inner.calls, 1);
    assert_eq!(outer.inclusive_ns, outer.exclusive_ns + inner.inclusive_ns);
    assert_eq!(inner.inclusive_ns, inner.exclusive_ns);
    assert!(ACTIVE.with(|active| active.borrow().is_none()));
    assert!(scope(Phase::Unpack).is_none());
}

#[test]
fn session_unwind_does_not_leak_into_the_next_extraction() {
    let failure = std::panic::catch_unwind(|| {
        collect(|| {
            let _scope = scope(Phase::TarMetadata);
            panic!("intentional profile-session unwind");
        });
    });
    assert!(failure.is_err());
    assert!(ACTIVE.with(|active| active.borrow().is_none()));
    let ((), next) = collect(|| {});
    assert_eq!(next.exclusive_ns(), 0);
}

#[test]
fn nested_sessions_are_rejected_without_discarding_the_outer_session() {
    let ((), profile) = collect(|| {
        let _outer = scope(Phase::TarMetadata);
        assert!(std::panic::catch_unwind(|| collect(|| {})).is_err());
    });
    assert_eq!(profile.phases[Phase::TarMetadata as usize].calls, 1);
    assert!(ACTIVE.with(|active| active.borrow().is_none()));
}

#[test]
fn same_phase_scopes_reject_out_of_order_drop_and_clean_up() {
    let failure = std::panic::catch_unwind(|| {
        collect(|| {
            let outer = scope(Phase::Unpack);
            let _inner = scope(Phase::Unpack);
            drop(outer);
        });
    });
    assert!(failure.is_err());
    assert!(ACTIVE.with(|active| active.borrow().is_none()));
}

#[test]
fn reported_quantiles_use_nearest_rank_and_mark_missing_observations() {
    assert_eq!(
        quantiles((1..=21).collect()),
        serde_json::json!({ "n": 21, "p50": 11, "p90": 19, "p95": 20 })
    );
    assert_eq!(quantiles(Vec::new()), serde_json::Value::Null);
}

#[test]
fn profiling_preserves_local_output_and_gzip_failure_partial_writes() {
    // Padding keeps the final gzip trailer beyond the tar end marker, so a
    // corrupt/missing trailer fails after accepted files have been written.
    let fixture = Fixture::with_padding(
        Case {
            name: "correctness",
            files: 3,
            bytes_per_file: 4096,
            depth: 2,
            compressible: false,
        },
        64 * 1024,
    )
    .unwrap();
    let root = tempfile::tempdir().unwrap();
    let archive = root.path().join("input.tar.gz");
    // Temp directories can be reached through a symlinked TMPDIR. Exercise that
    // alias here, while still honoring the extractor's canonical-target contract.
    let outputs = root.path().join("outputs");
    fs::create_dir(&outputs).unwrap();
    let output_alias = root.path().join("output-alias");
    std::os::unix::fs::symlink(&outputs, &output_alias).unwrap();
    for variant in ["valid", "corrupt_crc", "missing_trailer"] {
        let mut bytes = fixture.archive.clone();
        match variant {
            "corrupt_crc" => {
                let crc = bytes.len() - 8;
                bytes[crc] ^= 1;
            }
            "missing_trailer" => bytes.truncate(bytes.len() - 8),
            _ => {}
        }
        fs::write(&archive, &bytes).unwrap();
        let baseline_target = output_alias.join(format!("{variant}-baseline"));
        let profiled_target = output_alias.join(format!("{variant}-profiled"));
        fs::create_dir(&baseline_target).unwrap();
        fs::create_dir(&profiled_target).unwrap();
        let baseline_target = baseline_target.canonicalize().unwrap();
        let profiled_target = profiled_target.canonicalize().unwrap();
        let baseline = extract_tar_gz(source(&archive).unwrap(), &baseline_target);
        let (profiled, profile) =
            collect(|| extract_tar_gz(source(&archive).unwrap(), &profiled_target));
        assert_eq!(baseline.is_ok(), variant == "valid");
        assert_eq!(
            baseline.map_err(|error| error.to_string()),
            profiled.map_err(|error| error.to_string())
        );
        // The same accepted files remain after a late integrity failure; profiling
        // must not turn non-atomic extraction into a rollback or success.
        assert_eq!(tree(&baseline_target), tree(&profiled_target));
        fixture.verify(&baseline_target).unwrap();
        fixture.verify(&profiled_target).unwrap();
        assert_eq!(profile.phases[Phase::Unpack as usize].calls, 3);
        assert_eq!(profile.phases[Phase::EntryValidation as usize].calls, 3);
        assert!(ACTIVE.with(|active| active.borrow().is_none()));
    }
}

fn tree(root: &Path) -> Vec<(std::path::PathBuf, Vec<u8>, u64)> {
    fn visit(root: &Path, dir: &Path, files: &mut Vec<(std::path::PathBuf, Vec<u8>, u64)>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                visit(root, &entry.path(), files);
            } else {
                files.push((
                    entry.path().strip_prefix(root).unwrap().to_owned(),
                    fs::read(entry.path()).unwrap(),
                    entry.metadata().unwrap().len(),
                ));
            }
        }
    }
    let mut files = Vec::new();
    visit(root, root, &mut files);
    files.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    files
}

fn source(path: &Path) -> io::Result<ArchiveSource> {
    let file = File::open(path)?;
    let bytes = file.metadata()?.len();
    Ok(ArchiveSource::local(file, Some(bytes)))
}

#[cfg(target_os = "linux")]
fn cpu_ns() -> io::Result<Option<u64>> {
    let mut time = std::mem::MaybeUninit::<libc::timespec>::uninit();
    // SAFETY: the pointer is writable; successful clock_gettime initializes it.
    if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, time.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: clock_gettime returned success and initialized time.
    let time = unsafe { time.assume_init() };
    let seconds = u64::try_from(time.tv_sec).map_err(io::Error::other)?;
    let nanos = u64::try_from(time.tv_nsec).map_err(io::Error::other)?;
    Ok(Some(seconds * 1_000_000_000 + nanos))
}

#[cfg(not(target_os = "linux"))]
fn cpu_ns() -> io::Result<Option<u64>> {
    Ok(None)
}

#[cfg(target_os = "linux")]
fn peak_process_rss_kib() -> io::Result<Option<i64>> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: the pointer is writable; successful getrusage initializes the struct.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: getrusage returned success and initialized usage.
    Ok(Some(unsafe { usage.assume_init() }.ru_maxrss))
}

#[cfg(not(target_os = "linux"))]
fn peak_process_rss_kib() -> io::Result<Option<i64>> {
    Ok(None)
}

struct Sample {
    mode: &'static str,
    wall_ns: u64,
    cpu_ns: Option<u64>,
    profile: Option<Profile>,
}

fn sample(fixture: &Fixture, archive: &Path, target: &Path, profiling: bool) -> io::Result<Sample> {
    fs::create_dir(target)?;
    let target = target.canonicalize()?;
    let source = source(archive)?;
    let before_cpu = cpu_ns()?;
    let started = Instant::now();
    let (result, profile) = if profiling {
        let (result, profile) = collect(|| extract_tar_gz(source, &target));
        (result, Some(profile))
    } else {
        (extract_tar_gz(source, &target), None)
    };
    let wall_ns = u64::try_from(started.elapsed().as_nanos()).map_err(io::Error::other)?;
    let after_cpu = cpu_ns()?;
    result.map_err(|error| io::Error::other(error.to_string()))?;
    fixture.verify(&target)?;
    if let Some(profile) = &profile {
        assert!(profile.exclusive_ns() <= wall_ns);
    }
    let cpu_ns = before_cpu
        .zip(after_cpu)
        .map(|(before, after)| after - before);
    Ok(Sample {
        mode: if profiling { "profiled" } else { "baseline" },
        wall_ns,
        cpu_ns,
        profile,
    })
}

fn quantiles(mut values: Vec<u64>) -> serde_json::Value {
    values.sort_unstable();
    if values.is_empty() {
        return serde_json::Value::Null;
    }
    let rank = |percent: usize| values[(values.len() * percent).div_ceil(100) - 1];
    serde_json::json!({ "n": values.len(), "p50": rank(50), "p90": rank(90), "p95": rank(95) })
}

fn summary(samples: &[Sample]) -> serde_json::Value {
    serde_json::json!({
        "wall_ns": quantiles(samples.iter().map(|sample| sample.wall_ns).collect()),
        "cpu_ns": quantiles(samples.iter().filter_map(|sample| sample.cpu_ns).collect()),
        "outside_scopes_ns": quantiles(samples.iter().filter_map(|sample| sample.profile.as_ref().map(|profile| sample.wall_ns - profile.exclusive_ns())).collect()),
        "phases": PHASES.iter().map(|phase| {
            let stats = samples.iter().filter_map(|sample| sample.profile.as_ref().map(|profile| profile.phases[*phase as usize])).collect::<Vec<_>>();
            serde_json::json!({
                "name": phase.name(),
                "calls": quantiles(stats.iter().map(|stats| stats.calls).collect()),
                "inclusive_ns": quantiles(stats.iter().map(|stats| stats.inclusive_ns).collect()),
                "exclusive_ns": quantiles(stats.iter().map(|stats| stats.exclusive_ns).collect()),
            })
        }).collect::<Vec<_>>(),
    })
}

#[test]
#[ignore = "explicit local release-mode component profiling; not a CI latency assertion"]
fn local_archive_profile() -> io::Result<()> {
    const WARMUPS: usize = 2;
    const ITERATIONS: usize = 21;
    println!(
        "ARCHIVE_PROFILE_CONTEXT {}",
        serde_json::json!({
            "arch": std::env::consts::ARCH,
            "os": std::env::consts::OS,
            "crate_version": env!("CARGO_PKG_VERSION"),
            "optimized_build": !cfg!(debug_assertions),
            "warmups_per_mode": WARMUPS,
            "iterations_per_mode": ITERATIONS,
            "cpu_scope": if cfg!(target_os = "linux") { "calling_thread_CLOCK_THREAD_CPUTIME_ID" } else { "unavailable" },
            "baseline": "inactive_observer_test_build_not_production_binary",
            "filesystem": "fresh_temporary_targets_warm_source_page_cache",
        })
    );
    for case in CASES {
        let fixture = Fixture::new(case)?;
        let root = tempfile::tempdir()?;
        let archive = root.path().join("input.tar.gz");
        fs::write(&archive, &fixture.archive)?;
        let mut baseline = Vec::new();
        let mut profiled = Vec::new();
        for iteration in 0..WARMUPS + ITERATIONS {
            // Alternate order to limit systematic cache/scheduler drift between modes.
            let order = if iteration % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            };
            for profiling in order {
                let target = root.path().join(format!("out-{iteration}-{profiling}"));
                let sample = sample(&fixture, &archive, &target, profiling)?;
                fs::remove_dir_all(&target)?;
                if iteration < WARMUPS {
                    continue;
                }
                println!(
                    "ARCHIVE_PROFILE_SAMPLE {}",
                    serde_json::json!({
                        "case": case.name,
                        "iteration": iteration - WARMUPS,
                        "mode": sample.mode,
                        "wall_ns": sample.wall_ns,
                        "cpu_ns": sample.cpu_ns,
                        "outside_scopes_ns": sample.profile.as_ref().map(|profile| sample.wall_ns - profile.exclusive_ns()),
                        "phases": sample.profile.as_ref().map(Profile::json),
                    })
                );
                if profiling {
                    profiled.push(sample);
                } else {
                    baseline.push(sample);
                }
            }
        }
        println!(
            "ARCHIVE_PROFILE_SUMMARY {}",
            serde_json::json!({
                "case": case.name,
                "files": fixture.case.files,
                "bytes_per_file": fixture.case.bytes_per_file,
                "directory_depth": fixture.case.depth,
                "compressible": fixture.case.compressible,
                "compressed_bytes": fixture.archive.len(),
                "baseline": summary(&baseline),
                "profiled": summary(&profiled),
            })
        );
    }
    println!(
        "ARCHIVE_PROFILE_RESOURCES {}",
        serde_json::json!({
            "peak_process_rss_kib": peak_process_rss_kib()?,
            "scope": "whole_test_process_including_fixture_generation_and_verification",
        })
    );
    Ok(())
}
