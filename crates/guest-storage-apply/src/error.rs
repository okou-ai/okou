#[derive(Debug)]
pub(crate) struct DownloadError {
    pub(crate) message: String,
    pub(crate) failure: crate::ApplyFailure,
}

impl DownloadError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            failure: crate::ApplyFailure::Failed,
        }
    }

    pub(crate) fn writing_target(message: impl Into<String>, error: std::io::Error) -> Self {
        Self {
            message: format!("{}: {error}", message.into()),
            failure: crate::ApplyFailure::from_target_io(&error),
        }
    }
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
