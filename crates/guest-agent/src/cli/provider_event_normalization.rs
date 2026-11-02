//! Provider normalization before canonical sequencing and secret masking.

use guest_contracts::managed_command::decode_managed_shell_command;
use serde_json::Value;

use crate::env::Framework;

pub(super) fn normalize_for_sequencing(framework: Framework, event: Value) -> Vec<Value> {
    let events = match framework {
        Framework::ClaudeCode => expand_message_content(event, false),
        Framework::Pi => expand_message_content(event, true),
        Framework::Codex => expand_codex_file_changes(event),
    };
    events
        .into_iter()
        .filter_map(|mut event| restore_original_command(framework, &mut event).then_some(event))
        .collect()
}

fn restore_original_command(framework: Framework, event: &mut Value) -> bool {
    let command = match framework {
        Framework::ClaudeCode => claude_bash_command_mut(event),
        Framework::Codex => codex_command_mut(event),
        Framework::Pi => None,
    };
    let Some(command) = command else {
        return true;
    };
    let Some(provider_command) = command.as_str() else {
        return true;
    };
    match decode_managed_shell_command(provider_command) {
        Ok(Some(original_command)) => {
            *command = Value::String(original_command);
            true
        }
        Ok(None) => true,
        Err(_) => false,
    }
}

fn claude_bash_command_mut(event: &mut Value) -> Option<&mut Value> {
    let block = event.pointer_mut("/message/content/0")?.as_object_mut()?;
    if block.get("type").and_then(Value::as_str) != Some("tool_use")
        || !block
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.eq_ignore_ascii_case("Bash"))
    {
        return None;
    }
    block.get_mut("input")?.as_object_mut()?.get_mut("command")
}

fn codex_command_mut(event: &mut Value) -> Option<&mut Value> {
    let item = event.get_mut("item")?.as_object_mut()?;
    if item.get("type").and_then(Value::as_str) != Some("command_execution") {
        return None;
    }
    item.get_mut("command")
}

fn expand_message_content(event: Value, lift_block_run_event_id: bool) -> Vec<Value> {
    let Value::Object(mut outer) = event else {
        return vec![event];
    };
    if !matches!(
        outer.get("type").and_then(Value::as_str),
        Some("assistant" | "user")
    ) {
        return vec![Value::Object(outer)];
    }

    let Some(message) = outer.get_mut("message").and_then(Value::as_object_mut) else {
        return vec![Value::Object(outer)];
    };
    let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else {
        return vec![Value::Object(outer)];
    };
    if content.len() <= 1 {
        let run_event_id = lift_block_run_event_id
            .then(|| content.first_mut().and_then(take_block_run_event_id))
            .flatten();
        if let Some(run_event_id) = run_event_id {
            outer.insert("runEventId".to_string(), run_event_id);
        }
        return vec![Value::Object(outer)];
    }

    let blocks = std::mem::take(content);
    let message = message.clone();
    blocks
        .into_iter()
        .map(|mut block| {
            let run_event_id = lift_block_run_event_id
                .then(|| take_block_run_event_id(&mut block))
                .flatten();
            let mut normalized_outer = outer.clone();
            if let Some(run_event_id) = run_event_id {
                normalized_outer.insert("runEventId".to_string(), run_event_id);
            }
            let mut normalized_message = message.clone();
            normalized_message.insert("content".to_string(), Value::Array(vec![block]));
            normalized_outer.insert("message".to_string(), Value::Object(normalized_message));
            Value::Object(normalized_outer)
        })
        .collect()
}

fn take_block_run_event_id(block: &mut Value) -> Option<Value> {
    block
        .as_object_mut()?
        .remove("runEventId")
        .filter(|value| value.as_str().is_some_and(|value| !value.is_empty()))
}

fn expand_codex_file_changes(event: Value) -> Vec<Value> {
    let Value::Object(mut outer) = event else {
        return vec![event];
    };
    if outer.get("type").and_then(Value::as_str) != Some("item.completed") {
        return vec![Value::Object(outer)];
    }

    let Some(item) = outer.get_mut("item").and_then(Value::as_object_mut) else {
        return vec![Value::Object(outer)];
    };
    if item.get("type").and_then(Value::as_str) != Some("file_change") {
        return vec![Value::Object(outer)];
    }
    let Some(changes) = item.get_mut("changes").and_then(Value::as_array_mut) else {
        return vec![Value::Object(outer)];
    };
    if changes.len() <= 1 {
        return vec![Value::Object(outer)];
    }

    let changes = std::mem::take(changes);
    let item = item.clone();
    changes
        .into_iter()
        .map(|change| {
            let mut normalized_outer = outer.clone();
            let mut normalized_item = item.clone();
            normalized_item.insert("changes".to_string(), Value::Array(vec![change]));
            normalized_outer.insert("item".to_string(), Value::Object(normalized_item));
            Value::Object(normalized_outer)
        })
        .collect()
}

#[cfg(test)]
mod tests;
