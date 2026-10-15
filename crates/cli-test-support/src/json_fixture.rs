//! Canonical JSON fixture bytes without repeated encoding of invariant fields.

use serde::Serialize;
use serde_json::Value;
use std::io::{self, Write};

pub struct JsonFieldTemplate {
    prefix: Vec<u8>,
    suffix: Vec<u8>,
}

impl JsonFieldTemplate {
    pub fn new(object: &Value, field: &str) -> io::Result<Self> {
        let fields = object.as_object().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "fixture must be a JSON object")
        })?;
        if !fields.contains_key(field) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "varying fixture field is absent",
            ));
        }
        let mut prefix = vec![b'{'];
        let mut suffix = Vec::new();
        let mut after_field = false;
        // Derive the split from Map iteration, preserving both sorted and
        // insertion-order builds even when text contains the field's name.
        for (index, (key, value)) in fields.iter().enumerate() {
            let bytes = if after_field {
                &mut suffix
            } else {
                &mut prefix
            };
            if index != 0 {
                bytes.push(b',');
            }
            serde_json::to_writer(&mut *bytes, key).map_err(io::Error::other)?;
            bytes.push(b':');
            if key == field {
                after_field = true;
            } else {
                serde_json::to_writer(bytes, value).map_err(io::Error::other)?;
            }
        }
        suffix.push(b'}');
        Ok(Self { prefix, suffix })
    }

    pub fn write(&self, output: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
        output.write_all(&self.prefix)?;
        serde_json::to_writer(&mut *output, value).map_err(io::Error::other)?;
        output.write_all(&self.suffix)
    }
}

struct SerializedByteCount(usize);

impl Write for SerializedByteCount {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("serialized fixture length overflow"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn serialized_len(value: &impl Serialize) -> Result<usize, serde_json::Error> {
    let mut count = SerializedByteCount(0);
    serde_json::to_writer(&mut count, value)?;
    Ok(count.0)
}

/// Search textual JSON values and member names without cloning or serialization.
/// This is not arbitrary serialized-JSON substring search: callers use literal
/// unescaped ASCII sentinels, not JSON syntax, escapes or primitive numbers.
pub fn contains_json_text(value: &Value, needle: &str) -> bool {
    match value {
        Value::String(text) => text.contains(needle),
        Value::Array(values) => values.iter().any(|value| contains_json_text(value, needle)),
        Value::Object(members) => members
            .iter()
            .any(|(key, value)| key.contains(needle) || contains_json_text(value, needle)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}
