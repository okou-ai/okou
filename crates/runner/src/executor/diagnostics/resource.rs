use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};
use tracing::warn;

use super::super::{
    AGENT_ABNORMAL_EXIT_DIAGNOSTIC_SCRIPT, AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT,
    ResourceFailureDiagnostics, ResourceFailureKind, SandboxReuseResult,
};
use crate::helper_exec::{helper_exec_succeeded, helper_exec_termination_label};
use crate::ids::RunId;

const ROOTFS_FULL_AVAILABLE_KB_THRESHOLD: u64 = 1024;
const DF_BLOCKS_MARKER: &str = "VM0_DF_BLOCKS_V1";
const DF_INODES_MARKER: &str = "VM0_DF_INODES_V1";

#[derive(Clone, Copy)]
enum FilesystemTable {
    Blocks,
    Inodes,
}

pub(in crate::executor) fn parse_agent_abnormal_exit_resource_diagnostics(
    stdout: &str,
) -> Option<ResourceFailureDiagnostics> {
    let mut diagnostics = ResourceFailureDiagnostics::default();
    let mut filesystem_table = FilesystemTable::Blocks;

    for line in stdout.lines() {
        match line.trim() {
            DF_BLOCKS_MARKER => {
                filesystem_table = FilesystemTable::Blocks;
                continue;
            }
            DF_INODES_MARKER => {
                filesystem_table = FilesystemTable::Inodes;
                continue;
            }
            _ => {}
        }

        if let Some(filesystem) = parse_filesystem_usage_line(line) {
            match (filesystem_table, filesystem.mount_point) {
                (FilesystemTable::Blocks, "/") => {
                    diagnostics.guest_root_fs_used_percent = Some(filesystem.used_percent);
                    diagnostics.guest_root_fs_available_kb = filesystem.available;
                }
                (FilesystemTable::Blocks, "/home/user/workspace") => {
                    diagnostics.guest_workspace_fs_used_percent = Some(filesystem.used_percent);
                }
                (FilesystemTable::Inodes, "/") => {
                    diagnostics.guest_root_fs_inode_used_percent = Some(filesystem.used_percent);
                    diagnostics.guest_root_fs_available_inodes = filesystem.available;
                }
                (FilesystemTable::Inodes, "/home/user/workspace") => {}
                (_, _) => {}
            }
        }

        if diagnostics.guest_memory_available_mb.is_none() {
            diagnostics.guest_memory_available_mb = parse_memory_available_mb(line);
        }
    }

    if rootfs_is_clearly_full(&diagnostics) {
        diagnostics.failure_kind = Some(ResourceFailureKind::GuestRootFilesystemFull);
    }

    (!diagnostics.is_empty()).then_some(diagnostics)
}

struct FilesystemUsage<'a> {
    mount_point: &'a str,
    used_percent: u16,
    available: Option<u64>,
}

fn parse_filesystem_usage_line(line: &str) -> Option<FilesystemUsage<'_>> {
    let columns: Vec<&str> = line.split_whitespace().collect();
    if columns.len() < 6 {
        return None;
    }

    let mount_point = *columns.last()?;
    if mount_point != "/" && mount_point != "/home/user/workspace" {
        return None;
    }

    let used_percent = columns
        .get(columns.len().saturating_sub(2))
        .and_then(|value| parse_percent(value))?;
    let available = columns
        .get(columns.len().saturating_sub(3))
        .and_then(|value| parse_available_value(value));

    Some(FilesystemUsage {
        mount_point,
        used_percent,
        available,
    })
}

fn parse_percent(value: &str) -> Option<u16> {
    value.strip_suffix('%')?.parse().ok()
}

fn parse_available_value(value: &str) -> Option<u64> {
    if let Ok(kb) = value.parse() {
        return Some(kb);
    }

    let suffix = value.chars().last()?;
    let unit_multiplier = match suffix {
        'K' | 'k' => 1,
        'M' | 'm' => 1024,
        'G' | 'g' => 1024 * 1024,
        'T' | 't' => 1024 * 1024 * 1024,
        _ => return None,
    };
    let numeric = &value[..value.len() - suffix.len_utf8()];
    let amount: f64 = numeric.parse().ok()?;
    if !amount.is_finite() || amount.is_sign_negative() {
        return None;
    }
    Some((amount * unit_multiplier as f64).round() as u64)
}

fn parse_memory_available_mb(line: &str) -> Option<u64> {
    let columns: Vec<&str> = line.split_whitespace().collect();
    if columns.first() == Some(&"Mem:") && columns.len() >= 7 {
        columns.get(6).and_then(|value| value.parse().ok())
    } else if let ["MemAvailable:", kb, ..] = columns.as_slice() {
        kb.parse::<u64>().ok().map(|value| value / 1024)
    } else {
        None
    }
}

fn rootfs_is_clearly_full(diagnostics: &ResourceFailureDiagnostics) -> bool {
    diagnostics
        .guest_root_fs_used_percent
        .is_some_and(|percent| percent >= 100)
        || diagnostics
            .guest_root_fs_available_kb
            .is_some_and(|available_kb| available_kb <= ROOTFS_FULL_AVAILABLE_KB_THRESHOLD)
        || diagnostics
            .guest_root_fs_inode_used_percent
            .is_some_and(|percent| percent >= 100)
        || diagnostics.guest_root_fs_available_inodes == Some(0)
}

pub(in crate::executor) async fn collect_agent_abnormal_exit_diagnostics(
    sandbox: &dyn Sandbox,
    run_id: RunId,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    exit_code: i32,
) -> Option<ResourceFailureDiagnostics> {
    let request = ExecRequest {
        cmd: AGENT_ABNORMAL_EXIT_DIAGNOSTIC_SCRIPT,
        timeout: AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT,
        env: &[],
        sudo: true,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
    };

    match sandbox
        .exec_with_diagnostic_label(&request, "agent-abnormal-exit-diagnostics")
        .await
    {
        Ok(result) => {
            let stdout = String::from_utf8_lossy(&result.stdout);
            let stderr = String::from_utf8_lossy(&result.stderr);
            // Axiom bounds each text field independently. Keep usage evidence
            // separate from the binary/resource prefix and kernel diagnostics.
            let guest_root_fs_usage =
                stdout
                    .split_once("\n== rootfs-usage ==\n")
                    .map(|(_, section)| {
                        section
                            .split_once("\n== ")
                            .map_or(section, |(usage, _)| usage)
                            .trim()
                    });
            let diagnostic_succeeded = helper_exec_succeeded(&result);
            let resource_diagnostics = parse_agent_abnormal_exit_resource_diagnostics(&stdout);
            let resource_failure_kind = resource_diagnostics
                .and_then(|diagnostics| diagnostics.failure_kind)
                .map(ResourceFailureKind::as_str);
            let guest_root_fs_used_percent = resource_diagnostics
                .and_then(|diagnostics| diagnostics.guest_root_fs_used_percent)
                .map(u64::from);
            let guest_root_fs_available_kb =
                resource_diagnostics.and_then(|diagnostics| diagnostics.guest_root_fs_available_kb);
            let guest_root_fs_inode_used_percent = resource_diagnostics
                .and_then(|diagnostics| diagnostics.guest_root_fs_inode_used_percent)
                .map(u64::from);
            let guest_root_fs_available_inodes = resource_diagnostics
                .and_then(|diagnostics| diagnostics.guest_root_fs_available_inodes);
            let guest_workspace_fs_used_percent = resource_diagnostics
                .and_then(|diagnostics| diagnostics.guest_workspace_fs_used_percent)
                .map(u64::from);
            let guest_memory_available_mb =
                resource_diagnostics.and_then(|diagnostics| diagnostics.guest_memory_available_mb);
            macro_rules! emit_diagnostics {
                ($level:expr) => {
                    tracing::event!(
                        $level,
                        run_id = %run_id,
                        sandbox_id = %sandbox_id,
                        sandbox_reuse_result = reuse_result.as_wire(),
                        exit_code,
                        diagnostic_termination = helper_exec_termination_label(&result),
                        diagnostic_succeeded,
                        diagnostic_stdout_len = result.stdout.len(),
                        diagnostic_stderr_len = result.stderr.len(),
                        diagnostic_stdout_truncated = result.stdout_truncated,
                        diagnostic_stderr_truncated = result.stderr_truncated,
                        resource_failure_kind,
                        guest_root_fs_used_percent,
                        guest_root_fs_available_kb,
                        guest_root_fs_inode_used_percent,
                        guest_root_fs_available_inodes,
                        guest_workspace_fs_used_percent,
                        guest_memory_available_mb,
                        diagnostic_stdout = %stdout,
                        guest_root_fs_usage,
                        diagnostic_stderr = %stderr,
                        "agent abnormal exit in-vm diagnostics"
                    );
                };
            }
            if resource_diagnostics.and_then(|diagnostics| diagnostics.failure_kind)
                == Some(ResourceFailureKind::GuestRootFilesystemFull)
            {
                emit_diagnostics!(tracing::Level::INFO);
            } else {
                emit_diagnostics!(tracing::Level::WARN);
            }
            resource_diagnostics
        }
        Err(error) => {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                sandbox_reuse_result = reuse_result.as_wire(),
                exit_code,
                error = %error,
                "failed to collect agent abnormal exit in-vm diagnostics"
            );
            None
        }
    }
}
