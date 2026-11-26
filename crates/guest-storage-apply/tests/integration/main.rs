mod support;

mod binary_logging;
mod cleanup;
mod decoded_files;
mod download;
mod file_scheme;
mod gzip_integrity;
mod instruction_cleanup;
mod preparation_failure;
mod process;
mod quarantine;
mod readiness;
mod rooted_extraction;
mod scheduling;
#[cfg(target_os = "linux")]
mod startup_targets;

mod agent_instructions;

mod template_guidance;
