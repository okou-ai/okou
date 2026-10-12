use super::{Duration, HostMemoryPressure, HostPressureState, HostPressureUnknown, Input, policy};

#[tokio::test(start_paused = true)]
async fn one_bounded_wave_needs_completion_new_read_and_cooldown() {
    let input = Input::new();
    let mut pressure = HostMemoryPressure::new(policy()).unwrap();
    pressure.observe(input.available(0).await);
    let wave = pressure.try_begin_wave().unwrap();
    assert_eq!(wave.max_entries(), policy().max_wave_entries);
    assert!(pressure.decision().wave_inflight);
    assert!(pressure.try_begin_wave().is_none());
    let before_completion = input.available(16).await;
    pressure.observe(before_completion.clone());
    tokio::time::advance(Duration::from_secs(3)).await;
    let decision = pressure.observe(input.available(16).await);
    assert_eq!(decision.state, HostPressureState::Recovering);
    assert!(decision.wave_inflight);
    assert!(!pressure.take_optional_start());
    let last_read = input.available(0).await;
    pressure.observe(last_read.clone());
    pressure.complete_wave(wave).unwrap();
    assert_eq!(pressure.decision().state, HostPressureState::Unknown);
    assert!(pressure.try_begin_wave().is_none());
    let reused = pressure.observe(last_read);
    assert_eq!(
        reused.unknown,
        Some(HostPressureUnknown::BeforeWaveCompletion)
    );
    let fresh = pressure.observe(input.available(0).await);
    assert_eq!(fresh.state, HostPressureState::Critical);
    assert!(!fresh.wave_ready);
    tokio::time::advance(policy().wave_cooldown).await;
    pressure.observe(input.available(0).await);
    let next = pressure.try_begin_wave().unwrap();
    pressure.complete_wave(next).unwrap();
}

#[tokio::test(start_paused = true)]
async fn foreign_and_lost_tokens_never_complete_a_local_wave() {
    let input = Input::new();
    let mut first = HostMemoryPressure::new(policy()).unwrap();
    let mut second = HostMemoryPressure::new(policy()).unwrap();
    let critical = input.available(0).await;
    first.observe(critical.clone());
    second.observe(critical);
    let first_wave = first.try_begin_wave().unwrap();
    let second_wave = second.try_begin_wave().unwrap();
    let returned = second.complete_wave(first_wave).unwrap_err();
    assert!(first.decision().wave_inflight);
    assert!(second.decision().wave_inflight);
    first.complete_wave(returned).unwrap();
    second.complete_wave(second_wave).unwrap();
    tokio::time::advance(policy().wave_cooldown).await;
    first.observe(input.available(0).await);
    let lost = first.try_begin_wave().unwrap();
    drop(lost);
    tokio::time::advance(Duration::from_secs(3600)).await;
    first.observe(input.available(0).await);
    assert!(first.decision().wave_inflight);
    assert!(first.try_begin_wave().is_none());
    assert!(!first.take_optional_start());
}

#[tokio::test(start_paused = true)]
async fn optional_starts_are_paced_and_need_a_distinct_fresh_read() {
    let input = Input::new();
    let mut pressure = HostMemoryPressure::new(policy()).unwrap();
    input.recover(&mut pressure).await;
    let read = input.available(16).await;
    pressure.observe(read.clone());
    assert!(pressure.take_optional_start());
    assert!(!pressure.take_optional_start());
    tokio::time::advance(policy().optional_start_interval).await;
    pressure.observe(read);
    assert!(
        !pressure.take_optional_start(),
        "one cached read is not another start"
    );
    pressure.observe(input.available(16).await);
    assert!(pressure.take_optional_start());
    pressure.observe(input.available(16).await);
    assert!(
        !pressure.take_optional_start(),
        "a new read alone does not bypass cadence"
    );
    tokio::time::advance(policy().optional_start_interval).await;
    pressure.observe(input.available(16).await);
    assert!(pressure.take_optional_start());
}

#[tokio::test(start_paused = true)]
async fn post_wave_recovery_also_obeys_cooldown() {
    let input = Input::new();
    let mut pressure = HostMemoryPressure::new(super::HostPressurePolicy {
        recovery_sustain: Duration::from_secs(1),
        ..policy()
    })
    .unwrap();
    pressure.observe(input.available(0).await);
    let wave = pressure.try_begin_wave().unwrap();
    pressure.complete_wave(wave).unwrap();
    pressure.observe(input.available(16).await);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(
        pressure.observe(input.available(16).await).state,
        HostPressureState::Recovering
    );
    assert!(!pressure.take_optional_start());
    tokio::time::advance(Duration::from_secs(3)).await;
    assert_eq!(
        pressure.observe(input.available(16).await).state,
        HostPressureState::Ready
    );
    assert!(pressure.take_optional_start());
}
