use super::PrefetchOutcome;

/// Common reader evidence without admission, settlement, or producer ownership.
pub(super) struct ReaderAccounting<'a> {
    pub(super) completed: &'a mut usize,
    pub(super) cancelled: &'a mut usize,
    pub(super) failed: &'a mut usize,
    pub(super) read_bytes: &'a mut u64,
    pub(super) last_error: &'a mut Option<String>,
}

impl ReaderAccounting<'_> {
    pub(super) fn record(self, outcome: &PrefetchOutcome) {
        let bytes = match outcome {
            PrefetchOutcome::Complete { bytes } => {
                *self.completed += 1;
                *bytes
            }
            PrefetchOutcome::Cancelled { bytes } => {
                *self.cancelled += 1;
                *bytes
            }
            PrefetchOutcome::OpenFailed { error } => {
                *self.failed += 1;
                *self.last_error = Some(error.to_string());
                0
            }
            PrefetchOutcome::ReadFailed { bytes, error } => {
                *self.failed += 1;
                *self.last_error = Some(error.to_string());
                *bytes
            }
        };
        *self.read_bytes = self.read_bytes.saturating_add(bytes);
    }
}

#[cfg(test)]
mod tests;
