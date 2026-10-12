//! Validated native node configuration supplied by an authorized consumer.

use api_contracts::SecretText;
use std::sync::Arc;

use super::{Failure, Key};

#[derive(Clone)]
pub(crate) struct Configuration {
    // Sharing a registration never clones the private JIT credential payload.
    pub(super) authority: Arc<Authority>,
    key: Key,
}

pub(super) struct Authority {
    pub(super) client_id: SecretText<4096>,
    pub(super) client_secret: SecretText<4096>,
    pub(super) tags: Vec<String>,
}

impl Configuration {
    pub(crate) fn new(
        configuration: uuid::Uuid,
        generation: i64,
        client_id: SecretText<4096>,
        client_secret: SecretText<4096>,
        tags: Vec<String>,
    ) -> Result<Self, Failure> {
        let authority = Authority {
            client_id,
            client_secret,
            tags,
        };
        if configuration.is_nil()
            || !(1..=i64::from(i32::MAX)).contains(&generation)
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
            generation,
        };
        Ok(Self {
            authority: Arc::new(authority),
            key,
        })
    }

    pub(crate) fn key(&self) -> Key {
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
