use super::support::Harness;
use guest_control_client::FileCompression;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::time::{Duration, Instant};

fn source_options(raw: &[u8], encoded: &[u8]) -> FileCompression {
    FileCompression::ZstdSource {
        raw_size: u32::try_from(raw.len()).unwrap(),
        crc32: crc32fast::hash(encoded),
    }
}

fn assert_no_staging(h: &Harness) {
    assert!(fs::read_dir(&h.dir).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".vm0tmp-")
    }));
}

#[tokio::test]
async fn original_source_crosses_raw_and_encoded_request_caps_without_transcoding() {
    let h = Harness::new().await;
    let target = h.dir.join("source-history.jsonl");
    let mut state = 39245_u64;
    let random = (0..17 * 1024 * 1024 + 1)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 32) as u8
        })
        .collect::<Vec<_>>();
    for raw in [vec![b'x'; random.len()], random] {
        // Session history publishers do not request a frame checksum.
        let encoded = zstd::encode_all(raw.as_slice(), 3).unwrap();
        fs::write(&target, b"previous").unwrap();
        let measurements = h
            .host()
            .write_file_with_compression(
                target.to_str().unwrap(),
                &encoded,
                false,
                source_options(&raw, &encoded),
            )
            .await
            .unwrap();
        assert_eq!(fs::read(&target).unwrap(), raw);
        assert_eq!(measurements.wire_payload_bytes, encoded.len() as u64);
        assert_eq!(measurements.requests, 1);
        assert_eq!(measurements.encoder_pipeline_elapsed, Duration::ZERO);
        assert_no_staging(&h);
    }
    h.host()
        .quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap();
    h.host()
        .resume_operations(Duration::from_secs(2))
        .await
        .unwrap();
    h.finish();
}

#[tokio::test]
async fn failed_source_integrity_preserves_destination_and_cleans_each_sibling() {
    let h = Harness::new().await;
    let target = h.dir.join("integrity-history.jsonl");
    let raw = b"{\"type\":\"message\",\"content\":\"transcript\"}\n";
    let source = zstd::encode_all(raw.as_slice(), 3).unwrap();
    let options = source_options(raw, &source);
    let crc = crc32fast::hash(&source);
    let mut trailing = source.clone();
    trailing.extend_from_slice(b"trailing");
    let mut concatenated = source.clone();
    concatenated.extend_from_slice(&source);
    let malformed_frames =
        [source[..source.len() - 1].to_vec(), trailing, concatenated].map(|bytes| {
            // A matching transport CRC must not conceal a malformed frame.
            let options = source_options(raw, &bytes);
            (bytes, options)
        });
    let cases = [
        (
            source.clone(),
            FileCompression::ZstdSource {
                raw_size: raw.len() as u32,
                crc32: 0,
            },
        ),
        (
            source.clone(),
            FileCompression::ZstdSource {
                raw_size: raw.len() as u32 - 1,
                crc32: crc,
            },
        ),
        (
            source.clone(),
            FileCompression::ZstdSource {
                raw_size: raw.len() as u32 + 1,
                crc32: crc,
            },
        ),
    ];
    for (bytes, options) in cases.into_iter().chain(malformed_frames) {
        fs::write(&target, b"previous").unwrap();
        h.host()
            .write_file_with_compression(target.to_str().unwrap(), &bytes, false, options)
            .await
            .unwrap_err();
        assert_eq!(fs::read(&target).unwrap(), b"previous");
        assert_no_staging(&h);
    }
    h.host()
        .write_file_with_compression(target.to_str().unwrap(), &source, false, options)
        .await
        .unwrap();
    assert_eq!(fs::read(target).unwrap(), raw);
    assert_no_staging(&h);
    h.finish();
}

#[tokio::test]
async fn source_bounds_fail_before_starting_a_guest_write() {
    let h = Harness::new().await;
    let target = h.dir.join("bounded-source.jsonl");
    fs::write(&target, b"previous").unwrap();
    h.host()
        .write_file_with_compression(
            target.to_str().unwrap(),
            b"source",
            false,
            FileCompression::ZstdSource {
                raw_size: 128 * 1024 * 1024 + 1,
                crc32: 0,
            },
        )
        .await
        .unwrap_err();
    h.host()
        .write_file_with_compression(
            target.to_str().unwrap(),
            b"",
            false,
            source_options(b"", b""),
        )
        .await
        .unwrap_err();
    assert_eq!(fs::read(&target).unwrap(), b"previous");
    assert_no_staging(&h);
    h.host()
        .write_file(target.to_str().unwrap(), b"next", false)
        .await
        .unwrap();
    assert_eq!(fs::read(target).unwrap(), b"next");
    h.finish();
}

#[tokio::test]
async fn independent_large_source_restores_complete_concurrently() {
    let first = Harness::new().await;
    let second = Harness::new().await;
    let raw = vec![b'x'; 17 * 1024 * 1024];
    let encoded = zstd::encode_all(raw.as_slice(), 3).unwrap();
    let options = source_options(&raw, &encoded);
    let first_target = first.dir.join("history.jsonl");
    let second_target = second.dir.join("history.jsonl");
    let (left, right) = tokio::join!(
        first.host().write_file_with_compression(
            first_target.to_str().unwrap(),
            &encoded,
            false,
            options,
        ),
        second.host().write_file_with_compression(
            second_target.to_str().unwrap(),
            &encoded,
            false,
            options,
        ),
    );
    assert_eq!(left.unwrap().requests, 1);
    assert_eq!(right.unwrap().requests, 1);
    assert_eq!(fs::read(first_target).unwrap(), raw);
    assert_eq!(fs::read(second_target).unwrap(), raw);
    assert_no_staging(&first);
    assert_no_staging(&second);
    first.finish();
    second.finish();
}

fn usage(who: libc::c_int) -> libc::rusage {
    let mut value = std::mem::MaybeUninit::uninit();
    // SAFETY: getrusage initializes the supplied valid rusage on success.
    assert_eq!(unsafe { libc::getrusage(who, value.as_mut_ptr()) }, 0);
    // SAFETY: the successful call above initialized value.
    unsafe { value.assume_init() }
}

fn cpu_us(value: &libc::rusage) -> i64 {
    value.ru_utime.tv_sec * 1_000_000
        + value.ru_utime.tv_usec
        + value.ru_stime.tv_sec * 1_000_000
        + value.ru_stime.tv_usec
}

fn image_peak_kib() -> u64 {
    fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

/// Run one mode in a fresh test process with a prebuilt synthetic source. Fixture
/// generation/reading and final output verification are outside timing; input
/// loading remains visible to the isolated Host process RSS peak. The server
/// thread shares this process; helper CPU/RSS is reported separately.
#[tokio::test]
#[ignore = "opt-in synthetic restore comparison; requires OKOU_SOURCE_RESTORE_BENCH_* inputs"]
async fn measure_source_restore() {
    let mode = std::env::var("OKOU_SOURCE_RESTORE_BENCH_MODE").unwrap();
    let encoded = fs::read(std::env::var("OKOU_SOURCE_RESTORE_BENCH_INPUT").unwrap()).unwrap();
    let raw_size: u32 = std::env::var("OKOU_SOURCE_RESTORE_BENCH_RAW_SIZE")
        .unwrap()
        .parse()
        .unwrap();
    let expected: [u8; 32] = hex::decode(std::env::var("OKOU_SOURCE_RESTORE_BENCH_SHA").unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let h = Harness::new().await;
    let target = h.dir.join("history.jsonl");
    let before = usage(libc::RUSAGE_SELF);
    let child_before = usage(libc::RUSAGE_CHILDREN);
    let started = Instant::now();
    let prepared;
    let measurements = match mode.as_str() {
        "baseline" => {
            let raw = zstd::decode_all(encoded.as_slice()).unwrap();
            assert_eq!(Sha256::digest(&raw).as_slice(), expected);
            prepared = started.elapsed();
            let codec = if raw_size >= 16 * 1024 * 1024 {
                FileCompression::Zstd
            } else {
                FileCompression::None
            };
            h.host()
                .write_file_with_compression(target.to_str().unwrap(), &raw, false, codec)
                .await
                .unwrap()
        }
        "host_verified" => {
            let mut decoder = zstd::stream::read::Decoder::new(encoded.as_slice()).unwrap();
            let mut buffer = [0; 64 * 1024];
            let mut hash = Sha256::new();
            let mut decoded = 0;
            loop {
                let read = decoder.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                decoded += read;
                hash.update(&buffer[..read]);
            }
            assert_eq!(decoded, raw_size as usize);
            assert_eq!(hash.finalize().as_slice(), expected);
            let codec = FileCompression::ZstdSource {
                raw_size,
                crc32: crc32fast::hash(&encoded),
            };
            prepared = started.elapsed();
            h.host()
                .write_file_with_compression(target.to_str().unwrap(), &encoded, false, codec)
                .await
                .unwrap()
        }
        _ => panic!("unknown benchmark mode"),
    };
    let elapsed = started.elapsed();
    let after = usage(libc::RUSAGE_SELF);
    let child_after = usage(libc::RUSAGE_CHILDREN);
    let host_peak = image_peak_kib();
    let helper_peak = fs::read_dir(std::env::var("OKOU_SOURCE_RESTORE_BENCH_REPORT_DIR").unwrap())
        .unwrap()
        .map(|entry| {
            fs::read_to_string(entry.unwrap().path())
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        })
        .max()
        .unwrap();
    let mut file = fs::File::open(&target).unwrap();
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).unwrap();
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    assert_eq!(file.metadata().unwrap().len(), u64::from(raw_size));
    assert_eq!(hash.finalize().as_slice(), expected);
    println!(
        "SOURCE_RESTORE_BENCH mode={mode} raw={raw_size} encoded={} total_us={} prepare_us={} transfer_us={} host_cpu_us={} helper_cpu_us={} host_peak_kib={} helper_peak_kib={} wire={} requests={}",
        encoded.len(),
        elapsed.as_micros(),
        prepared.as_micros(),
        (elapsed - prepared).as_micros(),
        cpu_us(&after) - cpu_us(&before),
        cpu_us(&child_after) - cpu_us(&child_before),
        host_peak,
        helper_peak,
        measurements.wire_payload_bytes,
        measurements.requests
    );
    h.finish();
}
