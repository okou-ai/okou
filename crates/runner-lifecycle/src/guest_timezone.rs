use runner_types::types::ExecutionContext;

pub const DEFAULT_GUEST_TIMEZONE: &str = "UTC";

/// Claimed timezone intent retained with a runner-local idle sandbox.
///
/// This records the claim input, not proof that mutable guest files still
/// contain the requested timezone.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GuestTimezoneIntent {
    Configured(String),
    Default,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuestTimezoneAssumption {
    Match,
    Mismatch,
    Unknown,
}

impl GuestTimezoneIntent {
    pub fn from_context(context: &ExecutionContext) -> Self {
        match context.user_timezone.as_deref() {
            None | Some("") => Self::Default,
            Some(timezone) if is_shell_safe_name(timezone) => Self::Configured(timezone.to_owned()),
            Some(_) => Self::Unknown,
        }
    }

    pub fn guest_name(&self) -> Option<&str> {
        match self {
            Self::Configured(timezone) => Some(timezone),
            Self::Default => Some(DEFAULT_GUEST_TIMEZONE),
            Self::Unknown => None,
        }
    }

    pub fn is_usable_prediction(&self) -> bool {
        !matches!(self, Self::Unknown)
    }

    pub fn compare(&self, claimed: &Self) -> GuestTimezoneAssumption {
        if matches!(claimed, Self::Unknown) {
            GuestTimezoneAssumption::Unknown
        } else if self == claimed {
            GuestTimezoneAssumption::Match
        } else {
            GuestTimezoneAssumption::Mismatch
        }
    }
}

pub fn is_shell_safe_name(timezone: &str) -> bool {
    !timezone.is_empty()
        && timezone.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || byte == b'/'
                || byte == b'_'
                || byte == b'-'
                || byte == b'+'
        })
}
