use tokio::sync::watch;

use crate::lifecycle::RunnerMode;

#[derive(Clone, Default)]
pub(super) enum BackgroundGcActivity {
    #[default]
    Unrestricted,
    Running(watch::Receiver<RunnerMode>),
}

impl BackgroundGcActivity {
    pub(super) fn is_active(&self) -> bool {
        match self {
            Self::Unrestricted => true,
            Self::Running(mode) => {
                // A drain/resume round trip invalidates an old request even if
                // the watch coalesces both transitions to a Running value.
                let current = mode.borrow();
                *current == RunnerMode::Running && !mode.has_changed().unwrap_or(true)
            }
        }
    }
}
