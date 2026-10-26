//! Transparent observations used only inside exact guarded owner-test children.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

static MEASURING: AtomicBool = AtomicBool::new(false);
pub(super) static LARGEST: AtomicUsize = AtomicUsize::new(0);
pub(super) static RELEASED_PAYLOAD_BYTES: AtomicUsize = AtomicUsize::new(0);
pub(super) static LIVE_PAYLOAD_BYTES: AtomicUsize = AtomicUsize::new(0);
pub(super) const PAYLOAD_THRESHOLD: usize = 128 * 1024;

struct AllocationObserver;

fn observe(size: usize) {
    if MEASURING.load(Ordering::Relaxed) {
        LARGEST.fetch_max(size, Ordering::Relaxed);
    }
}

fn large_payload_bytes(size: usize) -> usize {
    if size >= PAYLOAD_THRESHOLD { size } else { 0 }
}

fn observe_live_allocation(size: usize) {
    if size >= PAYLOAD_THRESHOLD && MEASURING.load(Ordering::Relaxed) {
        LIVE_PAYLOAD_BYTES.fetch_add(size, Ordering::Relaxed);
    }
}

// Transparent test-only System delegation; observation does not allocate.
unsafe impl GlobalAlloc for AllocationObserver {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        observe(layout.size());
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            observe_live_allocation(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        observe(layout.size());
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            observe_live_allocation(layout.size());
        }
        pointer
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        observe(size);
        let pointer = unsafe { System.realloc(pointer, layout, size) };
        if !pointer.is_null() && MEASURING.load(Ordering::Relaxed) {
            LIVE_PAYLOAD_BYTES.fetch_sub(large_payload_bytes(layout.size()), Ordering::Relaxed);
            LIVE_PAYLOAD_BYTES.fetch_add(large_payload_bytes(size), Ordering::Relaxed);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        if MEASURING.load(Ordering::Relaxed) && layout.size() >= PAYLOAD_THRESHOLD {
            RELEASED_PAYLOAD_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
            LIVE_PAYLOAD_BYTES.fetch_sub(layout.size(), Ordering::Relaxed);
        }
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: AllocationObserver = AllocationObserver;

pub(super) struct Measurement;

impl Measurement {
    pub(super) fn start() -> Self {
        LARGEST.store(0, Ordering::Relaxed);
        RELEASED_PAYLOAD_BYTES.store(0, Ordering::Relaxed);
        LIVE_PAYLOAD_BYTES.store(0, Ordering::Relaxed);
        MEASURING.store(true, Ordering::Relaxed);
        Self
    }
}

impl Drop for Measurement {
    fn drop(&mut self) {
        MEASURING.store(false, Ordering::Relaxed);
    }
}
