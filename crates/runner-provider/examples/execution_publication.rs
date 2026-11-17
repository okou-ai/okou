//! Opt-in measurement of the real decoder, separate from ordinary test scheduling.
//! cargo run --release -p runner-provider --example execution_publication -- INPUT REPEATS
//! Use synthetic inputs. Counts are allocator requests/bytes, not RSS or live memory.

use runner_provider::decode_execution_publication;
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::hash_map::DefaultHasher;
use std::error::Error;
use std::hash::{Hash, Hasher};
use std::hint::black_box;
use std::io;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

static MEASURING: AtomicBool = AtomicBool::new(false);
static REQUESTS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);

struct AllocationObserver;

fn record(size: usize) {
    if MEASURING.load(Ordering::Relaxed) {
        REQUESTS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(size, Ordering::Relaxed);
    }
}

// SAFETY: Every operation delegates the same pointer/layout to System. Observation
// uses only atomics and does not allocate or change the allocator's contract.
unsafe impl GlobalAlloc for AllocationObserver {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        unsafe { System.realloc(pointer, layout, size) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: AllocationObserver = AllocationObserver;

fn cpu_ns() -> Result<u128, Box<dyn Error>> {
    let time = nix::time::clock_gettime(nix::time::ClockId::CLOCK_PROCESS_CPUTIME_ID)
        .map_err(io::Error::from)?;
    Ok(u128::try_from(time.tv_sec())? * 1_000_000_000 + u128::try_from(time.tv_nsec())?)
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("expected synthetic input file")?;
    let repeats: NonZeroUsize = args
        .next()
        .ok_or("expected positive repeat count")?
        .parse()?;
    if args.next().is_some() {
        return Err("expected only input file and repeat count".into());
    }
    let body = std::fs::read(path)?;
    // Validate and retain deterministic normalized result facts outside observation.
    let context = decode_execution_publication(&body).map_err(io::Error::other)?;
    let mut facts = DefaultHasher::new();
    context.run_id.to_string().hash(&mut facts);
    context.prompt.hash(&mut facts);
    let mut environment = context
        .environment
        .iter()
        .flat_map(|env| env.iter())
        .collect::<Vec<_>>();
    environment.sort_unstable();
    environment.hash(&mut facts);
    if let Some(manifest) = &context.storage_manifest {
        for entry in &manifest.storages {
            entry.mount_path.hash(&mut facts);
            entry.vas_version_id.hash(&mut facts);
            entry.archive_size.hash(&mut facts);
        }
    }
    let fingerprint = facts.finish();
    drop(context);
    drop(black_box(
        decode_execution_publication(&body).map_err(io::Error::other)?,
    ));

    REQUESTS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    MEASURING.store(true, Ordering::Relaxed);
    let measured = decode_execution_publication(black_box(&body));
    drop(black_box(measured));
    MEASURING.store(false, Ordering::Relaxed);
    let requests = REQUESTS.load(Ordering::Relaxed);
    let bytes = BYTES.load(Ordering::Relaxed);

    let cpu_start = cpu_ns()?;
    let start = Instant::now();
    for _ in 0..repeats.get() {
        drop(black_box(
            decode_execution_publication(black_box(&body)).map_err(io::Error::other)?,
        ));
    }
    let elapsed = start.elapsed().as_nanos();
    let cpu = cpu_ns()? - cpu_start;
    println!(
        "{{\"inputBytes\":{},\"repeats\":{},\"elapsedNs\":{},\"cpuNs\":{},\"allocationRequests\":{},\"allocatedBytes\":{},\"normalizedFingerprint\":{}}}",
        body.len(),
        repeats,
        elapsed,
        cpu,
        requests,
        bytes,
        fingerprint,
    );
    Ok(())
}
