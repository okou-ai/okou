//! Reproducible component benchmark for the storage-files input encoder.
//!
//! From `crates/`, run separately for each mode and mount count (1, 7, 14):
//! `cargo run --release --locked -p guest-contracts --example storage_input_encoding_bench -- baseline 14`
//! `cargo run --release --locked -p guest-contracts --example storage_input_encoding_bench -- direct 14`
//! Each mount has four 256 KiB files. This does not measure Runner startup or Guest apply.

use guest_contracts::storage_files::{self, StorageFile};
use std::hint::black_box;
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let (mode, count) = match args.as_slice() {
        [_, mode, count] if matches!(mode.as_str(), "baseline" | "direct") => {
            (mode.as_str(), count.parse::<usize>()?)
        }
        _ => return Err("usage: storage_input_encoding_bench baseline|direct 1|7|14".into()),
    };
    if !matches!(count, 1 | 7 | 14) {
        return Err("mount count must be 1, 7, or 14".into());
    }
    let owned: Vec<_> = (0..count)
        .map(|mount| {
            let files = (0..4)
                .map(|file| StorageFile {
                    path: format!("file-{file}"),
                    mode: 0o644,
                    mtime: 1,
                    content: vec![0x5a; storage_files::MAX_FILE_BYTES],
                })
                .collect::<Vec<_>>();
            (format!("/mount-{mount}"), files)
        })
        .collect();
    let groups: Vec<_> = owned
        .iter()
        .map(|(mount, files)| (mount.as_str(), files.as_slice()))
        .collect();
    let manifest = b"{}";
    let payload_len = storage_files::encoded_payload_len(&groups)?;
    // Benchmark each mode in a fresh process. Running both in one process
    // would make peak RSS and allocator reuse dependent on execution order.
    let mut samples_us = Vec::new();
    for _ in 0..51 {
        let started = Instant::now();
        let input = if mode == "baseline" {
            baseline(black_box(manifest), black_box(&groups))?
        } else {
            storage_files::encode_input(black_box(manifest), black_box(&groups))?
        };
        samples_us.push(started.elapsed().as_micros());
        black_box(input);
    }
    samples_us.sort_unstable();
    println!(
        "mode={mode} mounts={count} payload_bytes={payload_len} p50_us={} p90_us={}{}",
        samples_us
            .get(25)
            .ok_or("missing median benchmark sample")?,
        samples_us.get(45).ok_or("missing p90 benchmark sample")?,
        peak_rss_kib()
            .map(|rss| format!(" peak_process_rss_kib={rss}"))
            .unwrap_or_default()
    );
    Ok(())
}

// Reconstruct the previous implementation with the unchanged public payload encoder.
fn baseline(manifest: &[u8], groups: &[(&str, &[StorageFile])]) -> std::io::Result<Vec<u8>> {
    let payload = storage_files::encode(groups)?;
    let mut input = Vec::with_capacity(16 + manifest.len() + payload.len());
    input.extend_from_slice(storage_files::INPUT_MAGIC);
    input.extend_from_slice(&(manifest.len() as u32).to_be_bytes());
    input.extend_from_slice(manifest);
    input.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    input.extend_from_slice(&payload);
    Ok(input)
}

#[cfg(target_os = "linux")]
fn peak_rss_kib() -> Option<i64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage initializes `usage` on a successful return.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: getrusage returned success and initialized `usage`.
    Some(unsafe { usage.assume_init() }.ru_maxrss)
}

#[cfg(not(target_os = "linux"))]
fn peak_rss_kib() -> Option<i64> {
    None
}
