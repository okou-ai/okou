//! Only the private JIT response supplies node configuration and OAuth authority.

use api_contracts::generated::types::runners::ssh::ResolveResponseResolvedTailscaleTailscale;
use std::sync::Arc;

use super::{Failure, Key};

#[derive(Clone)]
pub(in crate::ssh) struct Configuration {
    // Sharing a registration never clones the private JIT credential payload.
    pub(super) authority: Arc<ResolveResponseResolvedTailscaleTailscale>,
    key: Key,
}

impl Configuration {
    pub(in crate::ssh) fn new(
        authority: ResolveResponseResolvedTailscaleTailscale,
    ) -> Result<Self, Failure> {
        let configuration =
            uuid::Uuid::parse_str(&authority.config_id).map_err(|_| Failure::DomainFailed)?;
        if configuration.is_nil()
            || !(1..=i64::from(i32::MAX)).contains(&authority.generation)
            || !valid_secret(authority.client_id.expose())
            || !valid_secret(authority.client_secret.expose())
            || authority.tags.is_empty()
            || authority.tags.len() > 16
            || authority.tags.iter().enumerate().any(|(index, tag)| {
                !valid_tag(tag) || authority.tags.iter().take(index).any(|prior| prior == tag)
            })
        {
            return Err(Failure::DomainFailed);
        }
        let key = Key {
            configuration,
            generation: authority.generation,
        };
        Ok(Self {
            authority: Arc::new(authority),
            key,
        })
    }

    pub(in crate::ssh) fn key(&self) -> Key {
        self.key
    }
}

fn valid_secret(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn valid_tag(value: &str) -> bool {
    let Some(value) = value.strip_prefix("tag:") else {
        return false;
    };
    (1..=63).contains(&value.len())
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
