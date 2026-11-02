use std::sync::atomic::{AtomicU8, Ordering};

use crate::RequestTimeoutStage;

#[derive(Debug, Default)]
pub(crate) struct RequestWriteProgress {
    stage: AtomicU8,
}

impl RequestWriteProgress {
    const BEFORE_FRAME_WRITE: u8 = 0;
    const FRAME_WRITE: u8 = 1;
    const AWAITING_TERMINAL_RESPONSE: u8 = 2;

    pub(crate) fn mark_frame_write(&self) {
        self.stage.store(Self::FRAME_WRITE, Ordering::Release);
    }

    pub(crate) fn mark_awaiting_terminal_response(&self) {
        self.stage
            .store(Self::AWAITING_TERMINAL_RESPONSE, Ordering::Release);
    }

    pub(crate) fn timeout_stage(&self) -> RequestTimeoutStage {
        match self.stage.load(Ordering::Acquire) {
            Self::BEFORE_FRAME_WRITE => RequestTimeoutStage::BeforeFrameWrite,
            Self::FRAME_WRITE => RequestTimeoutStage::FrameWrite,
            _ => RequestTimeoutStage::AwaitingTerminalResponse,
        }
    }
}
