# Supplied-envelope snapshot prefetch fixture

This opt-in case composes the real `IdlePressureOwner`, its same-state optional
capability, `MemoryPrefetchTasks` and `HostMemoryOperations`. It reads a disposable
copy of an operator-supplied snapshot with real `/proc/meminfo` observations and
joins every accepted owner, including timeout/refusal cleanup. It does not run
a Guest or establish the complete P3 native corpus.

Set `OKOU_TEST_PREFETCH_SNAPSHOT` to an authorized disposable `memory.bin` artifact
and `OKOU_TEST_PREFETCH_POLICY` to a JSON file with these required fields:

- `bounds`: `host_total_bytes`, `operating_floor_bytes`, `cleanup_reserve_bytes`,
  `critical_available_bytes`, `recovery_available_bytes`.
- `max_sample_age_millis`, `max_operations`, `max_cleanup_inflight`.
- `recovery_sustain_millis`, `wave_cooldown_millis`,
  `optional_start_interval_millis`, `sample_period_millis`.
- `live_growth_bytes`, `tail_growth_bytes`, `prefetch_overhead_bytes`,
  `snapshot_memory_mb`.

Use current measured/supplied host and optional IO envelopes; no numerical
defaults are provided. Overhead must cover at least the retained 1 MiB buffer.
The complete snapshot must fit its declared memory bound. Invalid, stale or
insufficient input does not authorize an uncovered read.

```bash
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner --test guarded_prefetch_native \
  guarded_snapshot_prefetch_joins_real_io_with_supplied_host_envelope -- --ignored --exact
```

Ordinary Cargo tests compile but do not execute this case. Copying the fixture
artifact already touches file pages; the case does not measure cold-cache
benefit or physical RAM savings. Read/phase completion is separate from resident
cache or released-byte proof. Combined Guest/session/history/pressure/optional
acceptance remains the separate P3d corpus; numerical production policy/full
foreground composition/overlap/activation require their own evidence.
