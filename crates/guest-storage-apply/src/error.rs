pub(crate) struct DownloadError {
    pub(crate) message: String,
    space_exhausted: bool,
}

impl DownloadError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            space_exhausted: false,
        }
    }

    pub(crate) fn from_io(message: impl Into<String>, error: std::io::Error) -> Self {
        Self {
            message: format!("{}: {error}", message.into()),
            space_exhausted: is_space_exhausted(&error),
        }
    }

    pub(crate) fn is_space_exhausted(&self) -> bool {
        self.space_exhausted
    }
}

pub(crate) fn is_space_exhausted(error: &std::io::Error) -> bool {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = current {
        if let Some(error) = error.downcast_ref::<std::io::Error>()
            && (matches!(error.raw_os_error(), Some(libc::ENOSPC | libc::EDQUOT))
                || matches!(
                    error.kind(),
                    std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded
                ))
        {
            return true;
        }
        current = error.source();
    }
    false
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
