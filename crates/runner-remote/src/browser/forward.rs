//! Transparent CDP forwarding after establishment-time authorization.

use serde_json::Value;

use super::{Failure, Result, client::Client};

/// Forwards Guest CDP messages to the established native connection unchanged.
///
/// Every method, parameter, session and event is passed through, including
/// browser-wide operations, cookie and storage access, nested `Target` routing
/// and methods this Runner has never seen. Nothing is denied, reordered,
/// indexed or rewritten: only the locally allocated native request id is mapped
/// back to the Guest's id, and native result, error and event payloads are
/// returned byte-identically in their fields.
pub(super) struct Forwarder {
    pub client: Client,
}

impl Forwarder {
    pub(super) fn new(client: Client) -> Self {
        Self { client }
    }

    pub(super) async fn dispatch(&mut self, input: Value) -> Result<Value> {
        let message = input.as_object().ok_or(Failure)?;
        let id = message.get("id").cloned().ok_or(Failure)?;
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .ok_or(Failure)?
            .to_owned();
        let params = message
            .get("params")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        let session = message
            .get("sessionId")
            .map(|session| session.as_str().ok_or(Failure))
            .transpose()?
            .map(str::to_owned);
        let mut reply = self
            .client
            .response(&method, params, session.as_deref())
            .await?;
        reply
            .as_object_mut()
            .ok_or(Failure)?
            .insert("id".to_owned(), id);
        Ok(reply)
    }
}
