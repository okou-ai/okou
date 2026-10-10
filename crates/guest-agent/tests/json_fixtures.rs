//! Compare optimized source and observation fixtures with their original bytes.

mod common;

use common::json_fixture::{JsonFieldTemplate, serialized_len};
use serde_json::{Value, json};
use std::io;

#[test]
fn varying_json_field_preserves_canonical_bytes_order_and_escaping() -> io::Result<()> {
    for object in [
        json!({"index":0}),
        json!({"index":0,"body":"你好\"\\\n\0\"index\":0"}),
        json!({"before":{"index":0},"index":0,"after":[null,true,19]}),
        json!({"type":"assistant","marker":"large-0","content":"x".repeat(4_096)}),
    ] {
        let original = object.to_string();
        for field in object.as_object().unwrap().keys() {
            let template = JsonFieldTemplate::new(&object, field)?;
            for value in [
                Value::Null,
                json!(0),
                json!(9),
                json!(10),
                json!(usize::MAX),
                json!("large-你好\"\\\n\0"),
                json!([{}, false]),
            ] {
                let mut expected = object.clone();
                *expected.get_mut(field).unwrap() = value.clone();
                let mut actual = Vec::new();
                template.write(&mut actual, &value)?;
                assert_eq!(actual, expected.to_string().as_bytes(), "field {field}");
            }
        }
        assert_eq!(object.to_string(), original);
    }
    Ok(())
}

#[test]
fn varying_json_field_requires_an_existing_object_member() {
    for object in [Value::Null, json!([]), json!(0), json!({})] {
        let error = JsonFieldTemplate::new(&object, "index").err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}

#[test]
fn counted_singleton_event_envelope_preserves_serialized_byte_lengths()
-> Result<(), serde_json::Error> {
    for run_id in ["", "batch-run", "你好\"\\\n\0"] {
        let empty = serialized_len(&json!({"runId":run_id,"events":[]}))?;
        for event in [
            Value::Null,
            json!({}),
            json!({"z-field":"你好\"\\\n\0","a-field":[null,true,19]}),
            json!({"sequenceNumber":19,"content":"x".repeat(2 * 1024 * 1024)}),
        ] {
            let original = json!({"runId":run_id,"events":[&event]});
            assert_eq!(
                empty + serialized_len(&event)?,
                serde_json::to_vec(&original)?.len()
            );
        }
    }
    Ok(())
}
