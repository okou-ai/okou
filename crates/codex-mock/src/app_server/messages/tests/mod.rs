use super::*;

#[test]
fn owned_plan_notification_preserves_canonical_jsonl() -> io::Result<()> {
    for plan in [
        vec![],
        vec![
            json!({"step":"step-000000-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz","status":"pending"}),
        ],
        vec![
            json!({"step":"你好\"\\\n\0", "status":"pending"}),
            json!({"z-field":[null, true, 19], "a-field":{}}),
        ],
    ] {
        let expected = json!({
            "method": "turn/plan/updated",
            "params": {
                "threadId": "thread-你好\"\\\n",
                "turnId": "turn-\0",
                "explanation": "oversized structural plan",
                "plan": &plan,
            }
        });
        let notification = plan_update_notification("thread-你好\"\\\n", "turn-\0", plan);
        let mut actual = Vec::new();
        write_json_line(&mut actual, &notification)?;
        assert_eq!(actual, format!("{expected}\n").as_bytes());
    }
    Ok(())
}

#[test]
fn owned_item_notifications_preserve_canonical_jsonl() -> io::Result<()> {
    for item in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"z-field":"你好\"\\\n\0", "a-field":[true, 7, null]}),
        json!({"body":"x".repeat(4_096)}),
    ] {
        for (method, timestamp_key, timestamp) in [
            ("item/started", "startedAtMs", 0),
            ("item/completed", "completedAtMs", i64::MAX),
        ] {
            let expected = json!({
                "method": method,
                "params": {
                    "threadId": "thread-你好\"\\\n",
                    "turnId": "turn-\0",
                    timestamp_key: timestamp,
                    "item": item,
                }
            });
            let owned_item = item.clone();
            let owned_body = owned_item
                .get("body")
                .and_then(Value::as_str)
                .map(str::as_ptr);
            let notification = item_notification(
                method,
                "thread-你好\"\\\n",
                "turn-\0",
                timestamp_key,
                timestamp,
                owned_item,
            );
            assert_eq!(
                notification
                    .pointer("/params/item/body")
                    .and_then(Value::as_str)
                    .map(str::as_ptr),
                owned_body,
            );
            let mut actual = Vec::new();
            write_json_line(&mut actual, &notification)?;
            assert_eq!(actual, format!("{expected}\n").as_bytes());
        }
    }
    Ok(())
}
