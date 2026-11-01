use std::{
    future::Future,
    task::{Context, Waker},
};

use super::{Budget, ENCODER_OVERHEAD, Error, MAX_PNG, encode_png};
use crate::memory::MAX_MEMORY;

#[tokio::test]
async fn small_png_uses_and_retains_only_grown_capacity() {
    let budget = Budget::default();
    let pixels = vec![255; 64 * 64 * 4];
    let png = encode_png(&pixels, 64, 64, &budget).await.unwrap();
    assert!(png.len() < MAX_PNG);
    assert!(budget.usage().1 < 3 * 1024 * 1024);
    assert_eq!(budget.usage().0, png.capacity());
    drop(png);
    assert_eq!(budget.usage().0, 0);
}

#[tokio::test]
async fn small_png_succeeds_with_less_than_max_output_headroom() {
    let budget = Budget::default();
    let occupied = budget
        .reserve(MAX_MEMORY - ENCODER_OVERHEAD - 64 * 1024)
        .unwrap();
    let pixels = vec![255; 64 * 64 * 4];
    let png = encode_png(&pixels, 64, 64, &budget).await.unwrap();
    assert!(png.len() < 64 * 1024);
    drop(png);
    assert_eq!(budget.usage().0, MAX_MEMORY - ENCODER_OVERHEAD - 64 * 1024);
    drop(occupied);
    assert_eq!(budget.usage().0, 0);
}

#[tokio::test]
async fn png_growth_failure_releases_temporary_reservations() {
    let budget = Budget::default();
    let occupied = budget.reserve(MAX_MEMORY - ENCODER_OVERHEAD - 512).unwrap();
    let pixels = vec![255; 64 * 64 * 4];
    assert!(matches!(
        encode_png(&pixels, 64, 64, &budget).await,
        Err(Error::ResourceLimit)
    ));
    assert_eq!(budget.usage().0, MAX_MEMORY - ENCODER_OVERHEAD - 512);
    drop(occupied);
    assert_eq!(budget.usage().0, 0);
}

#[tokio::test]
async fn cancelling_cpu_encoding_releases_output_and_compressor_reservations() {
    let budget = Budget::default();
    let pixels = vec![255; 64 * 64 * 4];
    // A socket-readiness wait cannot establish that PNG CPU work yields.
    // Poll only encoding, stop at its first row yield, then cancel it.
    let mut pending = Box::pin(encode_png(&pixels, 64, 64, &budget));
    let mut context = Context::from_waker(Waker::noop());
    assert!(pending.as_mut().poll(&mut context).is_pending());
    assert!(budget.usage().0 > 0);
    assert!(budget.usage().1 < 3 * 1024 * 1024);
    drop(pending);
    assert_eq!(budget.usage().0, 0);
}
