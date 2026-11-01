use super::*;
use serde_json::{Value, json};

fn fio_stdout(jobs: Vec<Value>) -> Vec<u8> {
    serde_json::to_vec(&json!({ "jobs": jobs })).unwrap()
}

fn fio_job(sections: Vec<(&str, Value)>) -> Value {
    let mut job = serde_json::Map::new();
    for (name, section) in sections {
        job.insert(name.to_string(), section);
    }
    Value::Object(job)
}

fn section(iops: f64, total_ios: u64, p50_ns: u64, p99_ns: u64) -> Value {
    json!({
        "iops": iops,
        "total_ios": total_ios,
        "clat_ns": {
            "percentile": {
                "50.000000": p50_ns,
                "99.000000": p99_ns,
            },
        },
    })
}

fn section_without_latency(iops: f64, total_ios: u64) -> Value {
    json!({
        "iops": iops,
        "total_ios": total_ios,
    })
}

fn inactive_section() -> Value {
    section_without_latency(0.0, 0)
}

#[test]
fn parse_fio_json_sums_mixed_read_write_iops() {
    let json = fio_stdout(vec![fio_job(vec![
        ("read", section(700.0, 700, 10000, 20000)),
        ("write", section(300.0, 300, 12000, 22000)),
        ("trim", inactive_section()),
        ("mixed", section(1000.0, 1000, 11000, 21000)),
    ])]);

    let result = parse_fio_json(&json).unwrap();

    assert_eq!(result.vm_iops, 1000);
    assert_eq!(result.lat_p50_us, 11);
    assert_eq!(result.lat_p99_us, 21);
}

#[test]
fn active_source_vm_iops_sums_read_write_without_mixed() {
    let root = json!({
        "jobs": [fio_job(vec![
            ("read", section_without_latency(700.0, 700)),
            ("write", section_without_latency(300.0, 300)),
            ("trim", inactive_section()),
        ])],
    });
    let jobs = fio_jobs(&root).unwrap();
    let active_source = select_active_fio_source(jobs);

    assert_eq!(
        active_source_vm_iops(&active_source, jobs).unwrap() as u64,
        1000
    );
}

#[test]
fn active_source_vm_iops_preserves_job_direction_sum_order() {
    let root = json!({
        "jobs": [
            fio_job(vec![
                ("read", section_without_latency(1.0, 1)),
                (
                    "write",
                    section_without_latency(10_000_000_000_000_000.0, 1),
                ),
            ]),
            fio_job(vec![("read", section_without_latency(1.0, 1))]),
        ],
    });
    let jobs = fio_jobs(&root).unwrap();
    let active_source = select_active_fio_source(jobs);

    assert_eq!(
        active_source_vm_iops(&active_source, jobs).unwrap(),
        10_000_000_000_000_000.0
    );
}

#[test]
fn parse_fio_json_prefers_mixed_section() {
    let json = fio_stdout(vec![fio_job(vec![
        ("read", section_without_latency(700.0, 700)),
        ("write", section_without_latency(300.0, 300)),
        ("trim", inactive_section()),
        ("mixed", section(950.0, 1000, 13000, 23000)),
    ])]);

    let result = parse_fio_json(&json).unwrap();

    assert_eq!(result.vm_iops, 950);
    assert_eq!(result.lat_p50_us, 13);
    assert_eq!(result.lat_p99_us, 23);
}

#[test]
fn parse_fio_json_accepts_float_percentile_values() {
    let json = br#"{
            "jobs": [{
                "mixed": {
                    "iops": 1000.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 13000.0, "99.000000": 23000.0}}
                }
            }]
        }"#;

    let result = parse_fio_json(json).unwrap();

    assert_eq!(result.lat_p50_us, 13);
    assert_eq!(result.lat_p99_us, 23);
}

#[test]
fn parse_fio_json_rejects_negative_iops() {
    let json = br#"{
            "jobs": [{
                "mixed": {
                    "iops": -1.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 13000, "99.000000": 23000}}
                }
            }]
        }"#;

    let err = parse_fio_json(json).unwrap_err();

    assert!(err.contains("mixed IOPS"), "{err}");
}

#[test]
fn parse_fio_json_rejects_negative_float_percentile_values() {
    let json = br#"{
            "jobs": [{
                "mixed": {
                    "iops": 1000.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": -1.0, "99.000000": 23000.0}}
                }
            }]
        }"#;

    let err = parse_fio_json(json).unwrap_err();

    assert!(err.contains("mixed p50 latency"), "{err}");
}

#[test]
fn parse_fio_json_rejects_huge_iops() {
    let json = br#"{
            "jobs": [{
                "mixed": {
                    "iops": 1e100,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 13000, "99.000000": 23000}}
                }
            }]
        }"#;

    let err = parse_fio_json(json).unwrap_err();

    assert!(err.contains("VM IOPS"), "{err}");
}

#[test]
fn parse_fio_json_rejects_huge_float_percentile_values() {
    let json = br#"{
            "jobs": [{
                "mixed": {
                    "iops": 1000.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 1e100, "99.000000": 23000.0}}
                }
            }]
        }"#;

    let err = parse_fio_json(json).unwrap_err();

    assert!(err.contains("mixed p50 latency"), "{err}");
}

#[test]
fn parse_fio_json_ignores_inactive_mixed_section_for_read_only() {
    let json = fio_stdout(vec![fio_job(vec![
        ("read", section(512.0, 512, 8000, 16000)),
        ("write", inactive_section()),
        ("trim", inactive_section()),
        ("mixed", inactive_section()),
    ])]);

    let result = parse_fio_json(&json).unwrap();

    assert_eq!(result.vm_iops, 512);
    assert_eq!(result.lat_p50_us, 8);
    assert_eq!(result.lat_p99_us, 16);
}

#[test]
fn parse_fio_json_rejects_active_mixed_section_missing_latency() {
    let json = br#"{
            "jobs": [{
                "mixed": {"iops": 1000.0, "total_ios": 1000}
            }]
        }"#;

    let err = parse_fio_json(json).unwrap_err();

    assert!(err.contains("mixed p50 latency"), "{err}");
}

#[test]
fn parse_fio_json_rejects_active_direction_missing_iops() {
    let json = br#"{
            "jobs": [{
                "read": {
                    "total_ios": 512,
                    "clat_ns": {"percentile": {"50.000000": 8000, "99.000000": 16000}}
                }
            }]
        }"#;

    let err = parse_fio_json(json).unwrap_err();

    assert!(err.contains("active direction IOPS"), "{err}");
}

#[test]
fn parse_fio_json_preserves_inactive_direction_iops_fallback() {
    let json = br#"{
            "jobs": [{
                "read": {"iops": 0.0, "total_ios": 0},
                "write": {"iops": 0.0, "total_ios": 0},
                "trim": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

    let err = parse_fio_json(json).unwrap_err();

    assert!(err.contains("no active read/write/trim direction"), "{err}");
}

#[test]
fn active_source_vm_iops_sums_multiple_jobs() {
    let root = json!({
        "jobs": [
            fio_job(vec![("mixed", section(600.0, 600, 10000, 20000))]),
            fio_job(vec![("mixed", section(400.0, 400, 12000, 22000))]),
        ],
    });
    let jobs = fio_jobs(&root).unwrap();
    let active_source = select_active_fio_source(jobs);

    assert_eq!(
        active_source_vm_iops(&active_source, jobs).unwrap() as u64,
        1000
    );
}

#[test]
fn parse_fio_json_rejects_multiple_mixed_latency_sections() {
    let json = br#"{
            "jobs": [
                {
                    "mixed": {
                        "iops": 600.0,
                        "total_ios": 600,
                        "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                    }
                },
                {
                    "mixed": {
                        "iops": 400.0,
                        "total_ios": 400,
                        "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                    }
                }
            ]
        }"#;

    let err = parse_fio_json(json).unwrap_err();

    assert!(err.contains("--group_reporting=1"), "{err}");
}

#[test]
fn parse_fio_json_rejects_multiple_read_latency_sections() {
    let json = br#"{
            "jobs": [
                {
                    "read": {
                        "iops": 600.0,
                        "total_ios": 600,
                        "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                    }
                },
                {
                    "read": {
                        "iops": 400.0,
                        "total_ios": 400,
                        "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                    }
                }
            ]
        }"#;

    let err = parse_fio_json(json).unwrap_err();

    assert!(err.contains("--group_reporting=1"), "{err}");
}

#[test]
fn parse_fio_json_accepts_read_only_without_mixed() {
    let json = fio_stdout(vec![fio_job(vec![
        ("read", section(512.0, 512, 8000, 16000)),
        ("write", inactive_section()),
        ("trim", inactive_section()),
    ])]);

    let result = parse_fio_json(&json).unwrap();

    assert_eq!(result.vm_iops, 512);
    assert_eq!(result.lat_p50_us, 8);
    assert_eq!(result.lat_p99_us, 16);
}

#[test]
fn parse_fio_json_accepts_write_only_without_mixed() {
    let json = fio_stdout(vec![fio_job(vec![
        ("read", inactive_section()),
        ("write", section(256.0, 256, 9000, 18000)),
        ("trim", inactive_section()),
    ])]);

    let result = parse_fio_json(&json).unwrap();

    assert_eq!(result.vm_iops, 256);
    assert_eq!(result.lat_p50_us, 9);
    assert_eq!(result.lat_p99_us, 18);
}

#[test]
fn parse_fio_json_rejects_mixed_latency_without_unified_stats() {
    let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 700.0,
                    "total_ios": 700,
                    "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                },
                "write": {
                    "iops": 300.0,
                    "total_ios": 300,
                    "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                },
                "trim": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

    let err = parse_fio_json(json).unwrap_err();

    assert!(err.contains("unified"), "{err}");
}

#[test]
fn parse_fio_json_rejects_mixed_latency_without_unified_stats_ignoring_inactive_mixed() {
    let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 700.0,
                    "total_ios": 700,
                    "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                },
                "write": {
                    "iops": 300.0,
                    "total_ios": 300,
                    "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                },
                "mixed": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

    let err = parse_fio_json(json).unwrap_err();

    assert!(err.contains("unified"), "{err}");
}

#[test]
fn parse_fio_json_rejects_invalid_json() {
    let err = parse_fio_json(b"not json").unwrap_err();

    assert!(err.contains("parse fio JSON"), "{err}");
}

#[test]
fn parse_fio_json_rejects_missing_or_empty_jobs() {
    let missing = parse_fio_json(br#"{}"#).unwrap_err();
    assert!(missing.contains("missing jobs array"), "{missing}");

    let empty = parse_fio_json(br#"{"jobs":[]}"#).unwrap_err();
    assert!(empty.contains("jobs array is empty"), "{empty}");
}
