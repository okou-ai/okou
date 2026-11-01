use super::*;
use std::collections::HashSet;
use std::path::PathBuf;

const COUNT_METRICS: [CountMetric; 9] = [
    CountMetric::Task,
    CountMetric::RemoteUrl,
    CountMetric::FileUrl,
    CountMetric::SkillChildTask,
    CountMetric::PotentialParentChildOverlap,
    CountMetric::MountConflictDeferral,
    CountMetric::InstructionsSkillConflictDeferral,
    CountMetric::ExactPathConflictDeferral,
    CountMetric::OtherParentChildConflictDeferral,
];
const COUNT_REPRESENTATIVES: [usize; 7] = [0, 1, 2, 3, 5, 9, 17];
const COMPRESSED_BYTE_REPRESENTATIVES: [u64; 8] = [
    0, 1, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864,
];
const EXPECTED_ACTION_SCHEMA: [&str; 95] = [
    "guest_storage_apply_task_count_0",
    "guest_storage_apply_task_count_1",
    "guest_storage_apply_task_count_2",
    "guest_storage_apply_task_count_3_4",
    "guest_storage_apply_task_count_5_8",
    "guest_storage_apply_task_count_9_16",
    "guest_storage_apply_task_count_17_plus",
    "guest_storage_apply_remote_url_count_0",
    "guest_storage_apply_remote_url_count_1",
    "guest_storage_apply_remote_url_count_2",
    "guest_storage_apply_remote_url_count_3_4",
    "guest_storage_apply_remote_url_count_5_8",
    "guest_storage_apply_remote_url_count_9_16",
    "guest_storage_apply_remote_url_count_17_plus",
    "guest_storage_apply_file_url_count_0",
    "guest_storage_apply_file_url_count_1",
    "guest_storage_apply_file_url_count_2",
    "guest_storage_apply_file_url_count_3_4",
    "guest_storage_apply_file_url_count_5_8",
    "guest_storage_apply_file_url_count_9_16",
    "guest_storage_apply_file_url_count_17_plus",
    "guest_storage_apply_skill_child_task_count_0",
    "guest_storage_apply_skill_child_task_count_1",
    "guest_storage_apply_skill_child_task_count_2",
    "guest_storage_apply_skill_child_task_count_3_4",
    "guest_storage_apply_skill_child_task_count_5_8",
    "guest_storage_apply_skill_child_task_count_9_16",
    "guest_storage_apply_skill_child_task_count_17_plus",
    "guest_storage_apply_potential_parent_child_overlap_count_0",
    "guest_storage_apply_potential_parent_child_overlap_count_1",
    "guest_storage_apply_potential_parent_child_overlap_count_2",
    "guest_storage_apply_potential_parent_child_overlap_count_3_4",
    "guest_storage_apply_potential_parent_child_overlap_count_5_8",
    "guest_storage_apply_potential_parent_child_overlap_count_9_16",
    "guest_storage_apply_potential_parent_child_overlap_count_17_plus",
    "guest_storage_apply_mount_conflict_deferral_count_0",
    "guest_storage_apply_mount_conflict_deferral_count_1",
    "guest_storage_apply_mount_conflict_deferral_count_2",
    "guest_storage_apply_mount_conflict_deferral_count_3_4",
    "guest_storage_apply_mount_conflict_deferral_count_5_8",
    "guest_storage_apply_mount_conflict_deferral_count_9_16",
    "guest_storage_apply_mount_conflict_deferral_count_17_plus",
    "guest_storage_apply_instructions_skill_conflict_deferral_count_0",
    "guest_storage_apply_instructions_skill_conflict_deferral_count_1",
    "guest_storage_apply_instructions_skill_conflict_deferral_count_2",
    "guest_storage_apply_instructions_skill_conflict_deferral_count_3_4",
    "guest_storage_apply_instructions_skill_conflict_deferral_count_5_8",
    "guest_storage_apply_instructions_skill_conflict_deferral_count_9_16",
    "guest_storage_apply_instructions_skill_conflict_deferral_count_17_plus",
    "guest_storage_apply_exact_path_conflict_deferral_count_0",
    "guest_storage_apply_exact_path_conflict_deferral_count_1",
    "guest_storage_apply_exact_path_conflict_deferral_count_2",
    "guest_storage_apply_exact_path_conflict_deferral_count_3_4",
    "guest_storage_apply_exact_path_conflict_deferral_count_5_8",
    "guest_storage_apply_exact_path_conflict_deferral_count_9_16",
    "guest_storage_apply_exact_path_conflict_deferral_count_17_plus",
    "guest_storage_apply_other_parent_child_conflict_deferral_count_0",
    "guest_storage_apply_other_parent_child_conflict_deferral_count_1",
    "guest_storage_apply_other_parent_child_conflict_deferral_count_2",
    "guest_storage_apply_other_parent_child_conflict_deferral_count_3_4",
    "guest_storage_apply_other_parent_child_conflict_deferral_count_5_8",
    "guest_storage_apply_other_parent_child_conflict_deferral_count_9_16",
    "guest_storage_apply_other_parent_child_conflict_deferral_count_17_plus",
    "guest_storage_apply_framework_home_instructions_task_absent",
    "guest_storage_apply_framework_home_instructions_task_present",
    "storage_download",
    "storage_download_remote_request_to_response_headers",
    "storage_download_remote_body_read",
    "storage_download_remote_extract_outside_body_read",
    "storage_download_remote_compressed_bytes_consumed_zero",
    "storage_download_remote_compressed_bytes_consumed_lt_64_kib",
    "storage_download_remote_compressed_bytes_consumed_64_kib_to_256_kib",
    "storage_download_remote_compressed_bytes_consumed_256_kib_to_1_mib",
    "storage_download_remote_compressed_bytes_consumed_1_mib_to_4_mib",
    "storage_download_remote_compressed_bytes_consumed_4_mib_to_16_mib",
    "storage_download_remote_compressed_bytes_consumed_16_mib_to_64_mib",
    "storage_download_remote_compressed_bytes_consumed_64_mib_plus",
    "storage_download_remote_attempt_count_1",
    "storage_download_file_body_read",
    "storage_download_file_extract_outside_body_read",
    "artifact_download",
    "artifact_download_remote_request_to_response_headers",
    "artifact_download_remote_body_read",
    "artifact_download_remote_extract_outside_body_read",
    "artifact_download_remote_compressed_bytes_consumed_zero",
    "artifact_download_remote_compressed_bytes_consumed_lt_64_kib",
    "artifact_download_remote_compressed_bytes_consumed_64_kib_to_256_kib",
    "artifact_download_remote_compressed_bytes_consumed_256_kib_to_1_mib",
    "artifact_download_remote_compressed_bytes_consumed_1_mib_to_4_mib",
    "artifact_download_remote_compressed_bytes_consumed_4_mib_to_16_mib",
    "artifact_download_remote_compressed_bytes_consumed_16_mib_to_64_mib",
    "artifact_download_remote_compressed_bytes_consumed_64_mib_plus",
    "artifact_download_remote_attempt_count_1",
    "artifact_download_file_body_read",
    "artifact_download_file_extract_outside_body_read",
];

fn action_schema() -> Vec<&'static str> {
    let mut actions = Vec::new();
    for metric in COUNT_METRICS {
        actions.extend(COUNT_REPRESENTATIVES.map(|count| metric.actions().action(count)));
    }
    actions.extend([
        framework_home_instructions_task_action(false),
        framework_home_instructions_task_action(true),
    ]);
    for archive_kind in [ArchiveKind::Storage, ArchiveKind::Artifact] {
        actions.extend([
            archive_kind.total_action(),
            archive_kind.request_to_response_headers_action(),
            archive_kind.body_read_action(),
            archive_kind.extract_outside_body_read_action(),
        ]);
        actions.extend(
            COMPRESSED_BYTE_REPRESENTATIVES
                .map(|bytes| archive_kind.compressed_bytes_consumed_action(bytes)),
        );
        actions.push(archive_kind.attempt_count_action());
        actions.extend([
            archive_kind.file_body_read_action(),
            archive_kind.file_extract_outside_body_read_action(),
        ]);
    }
    actions
}

#[test]
fn task_kind_classification_identifies_instructions_and_skill_children() {
    assert_eq!(
        DownloadTaskKind::FrameworkHomeInstructions.label(),
        "framework_home_instructions"
    );
    assert_eq!(
        DownloadTaskKind::FrameworkSkillChild.label(),
        "framework_skill_child"
    );
    assert_eq!(DownloadTaskKind::Other.label(), "other");
    assert_eq!(
        DownloadTaskTelemetry::storage(
            "https://example.com/archive.tar.gz",
            Path::new("/home/user/.codex"),
            true,
        )
        .task_kind,
        DownloadTaskKind::FrameworkHomeInstructions
    );
    assert_eq!(
        DownloadTaskTelemetry::storage(
            "https://example.com/archive.tar.gz",
            Path::new("/home/user/.codex/skills/workflow"),
            false,
        )
        .task_kind,
        DownloadTaskKind::FrameworkSkillChild
    );
    assert_eq!(
        DownloadTaskTelemetry::storage(
            "https://example.com/archive.tar.gz",
            Path::new("/home/user/.claude/skills/tool"),
            false,
        )
        .task_kind,
        DownloadTaskKind::FrameworkSkillChild
    );
    assert_eq!(
        DownloadTaskTelemetry::storage(
            "https://example.com/archive.tar.gz",
            Path::new("/home/user/.codex/skills"),
            false,
        )
        .task_kind,
        DownloadTaskKind::Other
    );
    assert_eq!(
        DownloadTaskTelemetry::storage(
            "https://example.com/archive.tar.gz",
            Path::new("/workspace"),
            false,
        )
        .task_kind,
        DownloadTaskKind::Other
    );
}

#[test]
fn conflict_classifier_buckets_exact_instruction_skill_and_other_parent_child() {
    assert_eq!(
        classify_download_conflict(
            Path::new("/home/user/.codex/skills/foo"),
            DownloadTaskKind::FrameworkSkillChild,
            Path::new("/home/user/.codex"),
            DownloadTaskKind::FrameworkHomeInstructions,
        ),
        DownloadConflictKind::InstructionsSkill
    );
    assert_eq!(
        classify_download_conflict(
            Path::new("/same"),
            DownloadTaskKind::Other,
            Path::new("/same"),
            DownloadTaskKind::Other,
        ),
        DownloadConflictKind::ExactPath
    );
    assert_eq!(
        classify_download_conflict(
            Path::new("/tmp/parent/child"),
            DownloadTaskKind::Other,
            Path::new("/tmp/parent"),
            DownloadTaskKind::Other,
        ),
        DownloadConflictKind::OtherParentChild
    );
}

#[test]
fn potential_parent_child_overlap_count_excludes_exact_paths_and_siblings() {
    let paths = [
        PathBuf::from("/workspace"),
        PathBuf::from("/workspace/src"),
        PathBuf::from("/workspace/tests"),
        PathBuf::from("/workspace/src"),
        PathBuf::from("/workspace/src/nested"),
    ];

    assert_eq!(
        potential_parent_child_overlap_count(
            &paths.iter().map(PathBuf::as_path).collect::<Vec<_>>()
        ),
        6
    );
}

#[test]
fn count_bucket_boundaries_are_stable() {
    assert_eq!(
        [0, 1, 2, 3, 4, 5, 8, 9, 16, 17].map(|count| CountMetric::Task.actions().action(count)),
        [
            "guest_storage_apply_task_count_0",
            "guest_storage_apply_task_count_1",
            "guest_storage_apply_task_count_2",
            "guest_storage_apply_task_count_3_4",
            "guest_storage_apply_task_count_3_4",
            "guest_storage_apply_task_count_5_8",
            "guest_storage_apply_task_count_5_8",
            "guest_storage_apply_task_count_9_16",
            "guest_storage_apply_task_count_9_16",
            "guest_storage_apply_task_count_17_plus",
        ]
    );
}

#[test]
fn compressed_byte_bucket_boundaries_are_stable() {
    assert_eq!(
        [
            0, 1, 65_535, 65_536, 262_143, 262_144, 1_048_575, 1_048_576, 4_194_303, 4_194_304,
            16_777_215, 16_777_216, 67_108_863, 67_108_864,
        ]
        .map(CompressedBytesBucket::from_bytes),
        [
            CompressedBytesBucket::Zero,
            CompressedBytesBucket::Under64Kib,
            CompressedBytesBucket::Under64Kib,
            CompressedBytesBucket::Kib64To256,
            CompressedBytesBucket::Kib64To256,
            CompressedBytesBucket::Kib256To1Mib,
            CompressedBytesBucket::Kib256To1Mib,
            CompressedBytesBucket::Mib1To4,
            CompressedBytesBucket::Mib1To4,
            CompressedBytesBucket::Mib4To16,
            CompressedBytesBucket::Mib4To16,
            CompressedBytesBucket::Mib16To64,
            CompressedBytesBucket::Mib16To64,
            CompressedBytesBucket::Mib64Plus,
        ]
    );
}

#[test]
fn local_extraction_attribution_is_bounded_by_extraction_wall_time() {
    let mut metrics = LocalArchiveTaskMetrics::default();
    assert!(!metrics.extraction_started);
    metrics.record_extraction(Duration::from_millis(12), Duration::from_millis(30));
    assert!(metrics.extraction_started);
    assert_eq!(metrics.body_read, Duration::from_millis(12));
    assert_eq!(metrics.extract_outside_body_read, Duration::from_millis(18));

    metrics.record_extraction(Duration::from_millis(31), Duration::from_millis(30));
    assert_eq!(metrics.body_read, Duration::from_millis(30));
    assert_eq!(metrics.extract_outside_body_read, Duration::ZERO);
}

#[test]
fn complete_action_schema_is_exact_and_unique() {
    let actions = action_schema();

    assert_eq!(actions.as_slice(), EXPECTED_ACTION_SCHEMA.as_slice());
    assert_eq!(actions.iter().copied().collect::<HashSet<_>>().len(), 95);
}
