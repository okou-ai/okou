use std::{io, path::Path};

use guest_contracts::{agent_instructions::RestoredInstructionCheck, home_mount::HOME_DIR};
use guest_storage_apply::ApplyFailure;
use nix::unistd::{User, initgroups, setgid, setuid};

pub(super) fn check(metadata: &[u8]) -> RestoredInstructionCheck {
    if let Err(error) = drop_to_sandbox_user() {
        eprintln!("guest-state-restore: failed to select sandbox user: {error}");
        return RestoredInstructionCheck::Failed;
    }
    match guest_storage_apply::check_agent_instructions(Path::new(HOME_DIR), metadata) {
        Ok(checked) if checked.memory_root_present => RestoredInstructionCheck::CurrentWithMemory,
        Ok(checked) if checked.instructions_current => RestoredInstructionCheck::Current,
        Ok(_) => RestoredInstructionCheck::Missing,
        Err(error) => {
            eprintln!("guest-state-restore: Instruction file check failed: {error}");
            match ApplyFailure::from_target_io(&error) {
                ApplyFailure::TargetUnavailable => RestoredInstructionCheck::TargetUnavailable,
                ApplyFailure::Failed => RestoredInstructionCheck::Failed,
            }
        }
    }
}

fn drop_to_sandbox_user() -> io::Result<()> {
    let user = User::from_name("user")?
        .filter(|user| !user.uid.is_root())
        .ok_or_else(|| io::Error::other("missing unprivileged sandbox user"))?;
    // The fixed helper has finished its privileged work. Change supplementary
    // groups and permanently drop the root identity before looking at Home.
    initgroups(c"user", user.gid)?;
    setgid(user.gid)?;
    setuid(user.uid)?;
    Ok(())
}
