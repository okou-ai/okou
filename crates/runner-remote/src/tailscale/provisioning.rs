//! One narrow OAuth grant and one non-replayed ephemeral key per startup attempt.

use std::{cell::RefCell, rc::Rc, sync::Arc, time::Duration};

use api_contracts::SecretText;
use serde::{Deserialize, Serialize};
use ts_http_util::{HeaderValue, Method};
use zeroize::Zeroizing;

use super::{
    Failure,
    configuration::Configuration,
    domain::Control,
    provisioning_effect::{Cleanup, Journal},
    provisioning_io::{Admission, Api, Dial, encoded},
};

const TOKEN_PATH: &str = "/api/v2/oauth/token";
// The first-party OAuth contract defines '-' as the access token's own tailnet.
// No user-controlled tailnet selector or discovery scope is needed.
const KEYS_PATH: &str = "/api/v2/tailnet/-/keys";

struct Token {
    secret: SecretText<4096>,
    expires: tokio::time::Instant,
}

struct Inner<D> {
    configuration: Configuration,
    api: Api<D>,
    token: RefCell<Option<Token>>,
    journal: Arc<Journal>,
}

pub(super) struct Provider<D> {
    inner: Rc<Inner<D>>,
    cancelled: tokio_util::sync::CancellationToken,
}

pub(super) struct Key {
    secret: SecretText<4096>,
    journal: Arc<Journal>,
}

impl Key {
    pub(super) fn expose(&self) -> &str {
        self.secret.expose()
    }

    pub(super) fn consuming(&self) -> Result<(), Failure> {
        self.journal.consuming()
    }
}

impl<D: Dial> Provider<D> {
    pub(super) fn new(
        configuration: Configuration,
        journal: Arc<Journal>,
        dial: D,
        control: &Control,
    ) -> Result<Self, Failure> {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        let inner = Rc::new(Inner {
            configuration,
            api: Api::new(dial),
            token: RefCell::new(None),
            journal,
        });
        let retained = Rc::clone(&inner);
        let ready = control.ready_receipt();
        // This receipt, OAuth authority and finalizer exist before the first
        // provider await; dropping startup cannot discard known-unused cleanup.
        control.retain_finalizer(Box::pin(async move { retained.cleanup(ready()).await }))?;
        Ok(Self {
            inner,
            cancelled: control.cancelled(),
        })
    }

    pub(super) fn tags(&self) -> &[String] {
        &self.inner.configuration.authority.tags
    }

    pub(super) async fn create(&self) -> Result<Key, Failure> {
        super::diagnostics::Stage::Provisioning.record();
        let authorization = self
            .inner
            .authorization(Some(self.cancelled.clone()))
            .await?;
        #[derive(Serialize)]
        struct Create<'a> {
            #[serde(rename = "expirySeconds")]
            expiry_seconds: u32,
            capabilities: Capabilities<'a>,
        }
        #[derive(Serialize)]
        struct Capabilities<'a> {
            devices: Devices<'a>,
        }
        #[derive(Serialize)]
        struct Devices<'a> {
            create: Permission<'a>,
        }
        #[derive(Serialize)]
        struct Permission<'a> {
            reusable: bool,
            ephemeral: bool,
            preauthorized: bool,
            tags: &'a [String],
        }
        let request = Create {
            expiry_seconds: 86400,
            capabilities: Capabilities {
                devices: Devices {
                    create: Permission {
                        reusable: false,
                        ephemeral: true,
                        preauthorized: true,
                        tags: self.tags(),
                    },
                },
            },
        };
        let body = serde_json::to_vec(&request).map_err(|_| Failure::DomainFailed)?;
        let bytes = self
            .inner
            .api
            .request(
                Method::POST,
                KEYS_PATH,
                "application/json",
                body,
                Some(authorization),
                Admission {
                    cancelled: Some(self.cancelled.clone()),
                    creation: Some(Arc::clone(&self.inner.journal)),
                },
            )
            .await?;
        #[derive(Deserialize)]
        struct Identity {
            id: String,
        }
        let identity: Identity =
            serde_json::from_slice(&bytes).map_err(|_| Failure::DomainFailed)?;
        // Capture the exact ID before any later typed/expiry/capability failure.
        self.inner.journal.captured(&identity.id)?;
        let response: KeyResponse<'_> =
            serde_json::from_slice(&bytes).map_err(|_| Failure::DomainFailed)?;
        let permission = &response.capabilities.devices.create;
        let tags = self.tags();
        if permission.reusable
            || !permission.ephemeral
            || !permission.preauthorized
            || permission.tags.len() != tags.len()
            || tags
                .iter()
                .any(|tag| !permission.tags.contains(&tag.as_str()))
            || !valid_key(response.key.expose())
        {
            return Err(Failure::DomainFailed);
        }
        let created = chrono::DateTime::parse_from_rfc3339(response.created)
            .map_err(|_| Failure::DomainFailed)?;
        let expires = chrono::DateTime::parse_from_rfc3339(response.expires)
            .map_err(|_| Failure::DomainFailed)?;
        let now = chrono::Utc::now();
        if expires <= now
            || created > now + chrono::Duration::seconds(60)
            || (expires - created).num_seconds() != 86400
        {
            return Err(Failure::DomainFailed);
        }
        Ok(Key {
            secret: response.key,
            journal: Arc::clone(&self.inner.journal),
        })
    }
}

impl<D: Dial> Inner<D> {
    async fn authorization(
        &self,
        cancelled: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<HeaderValue, Failure> {
        if self
            .token
            .borrow()
            .as_ref()
            .is_none_or(|token| token.expires <= tokio::time::Instant::now())
        {
            #[derive(Deserialize)]
            struct Response {
                access_token: SecretText<4096>,
                token_type: String,
                expires_in: u64,
                scope: Option<String>,
                error: Option<String>,
            }
            let authority = &self.configuration.authority;
            let id = Zeroizing::new(encoded(authority.client_id.expose()));
            let secret = Zeroizing::new(encoded(authority.client_secret.expose()));
            let tags = encoded(&authority.tags.join(" "));
            let mut form = Zeroizing::new(format!(
                "grant_type=client_credentials&client_id={}&client_secret={}&scope=auth_keys&tags={tags}",
                id.as_str(),
                secret.as_str()
            ));
            let started = tokio::time::Instant::now();
            let response = self
                .api
                .request(
                    Method::POST,
                    TOKEN_PATH,
                    "application/x-www-form-urlencoded",
                    std::mem::take(&mut *form).into_bytes(),
                    None,
                    Admission {
                        cancelled,
                        creation: None,
                    },
                )
                .await?;
            let response: Response =
                serde_json::from_slice(&response).map_err(|_| Failure::DomainFailed)?;
            if !response.token_type.eq_ignore_ascii_case("Bearer")
                || !(1..=3600).contains(&response.expires_in)
                || response.error.is_some()
                || response
                    .scope
                    .as_ref()
                    .is_some_and(|scope| scope != "auth_keys")
                || !valid_token(response.access_token.expose())
            {
                return Err(Failure::DomainFailed);
            }
            let expires = started + Duration::from_secs(response.expires_in);
            if expires <= tokio::time::Instant::now() {
                return Err(Failure::DomainFailed);
            }
            *self.token.borrow_mut() = Some(Token {
                secret: response.access_token,
                expires,
            });
        }
        let token = self.token.borrow();
        let token = token.as_ref().ok_or(Failure::DomainFailed)?;
        let header = Zeroizing::new(format!("Bearer {}", token.secret.expose()));
        let mut header = HeaderValue::from_str(&header).map_err(|_| Failure::DomainFailed)?;
        header.set_sensitive(true);
        Ok(header)
    }

    async fn cleanup(&self, established: bool) -> Result<(), Failure> {
        if let Cleanup::Unused(id) = self.journal.cleanup(established)? {
            super::diagnostics::Stage::UnusedKeyCleanup.record();
            let authorization = self.authorization(None).await?;
            // Never list-match or delete another client's key. If DELETE or its
            // result is ambiguous, required cleanup fails and no retry is made.
            let path = format!("{KEYS_PATH}/{}", encoded(&id));
            let _ = self
                .api
                .request(
                    Method::DELETE,
                    &path,
                    "application/json",
                    Vec::new(),
                    Some(authorization),
                    Admission {
                        cancelled: None,
                        creation: None,
                    },
                )
                .await?;
            self.journal.cleaned()?;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct KeyResponse<'a> {
    key: SecretText<4096>,
    created: &'a str,
    expires: &'a str,
    #[serde(borrow)]
    capabilities: Capabilities<'a>,
}
#[derive(Deserialize)]
struct Capabilities<'a> {
    #[serde(borrow)]
    devices: Devices<'a>,
}
#[derive(Deserialize)]
struct Devices<'a> {
    #[serde(borrow)]
    create: Permission<'a>,
}
#[derive(Deserialize)]
struct Permission<'a> {
    reusable: bool,
    ephemeral: bool,
    preauthorized: bool,
    #[serde(borrow)]
    tags: Vec<&'a str>,
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}
fn valid_key(value: &str) -> bool {
    value.starts_with("tskey-auth-") && value.len() > "tskey-auth-".len() && valid_token(value)
}
