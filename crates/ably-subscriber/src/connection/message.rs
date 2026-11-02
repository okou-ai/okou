use crate::protocol::ProtocolMessage;

pub(super) fn message_targets_channel(msg: &ProtocolMessage, channel: &str) -> bool {
    msg.channel.as_deref() == Some(channel)
}

pub(super) fn decode_data(data: serde_json::Value, encoding: Option<&str>) -> serde_json::Value {
    let Some(encoding) = encoding else {
        return data;
    };
    if encoding.is_empty() {
        return data;
    }
    if encoding.split('/').any(|layer| layer == "base64") {
        return data;
    }
    let mut result = data;
    for layer in encoding.rsplit('/') {
        match layer {
            "json" => {
                if let serde_json::Value::String(ref s) = result {
                    match serde_json::from_str(s) {
                        Ok(parsed) => result = parsed,
                        Err(e) => {
                            // Intentional fallback: return raw data rather than failing the message.
                            tracing::warn!("Failed to decode JSON encoding layer: {e}");
                            return result;
                        }
                    }
                }
            }
            "utf-8" => {
                // No-op: MessagePack strings are already UTF-8
            }
            other => {
                tracing::warn!(
                    encoding = other,
                    "Unsupported encoding layer, returning raw data"
                );
                return result;
            }
        }
    }
    result
}

#[cfg(test)]
mod tests;
