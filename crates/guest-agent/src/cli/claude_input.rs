//! Claude stream-json stdin frames and replay-aware follow-up delivery.

use crate::active_input::ActiveInputWriter;
use crate::error::AgentError;
use tokio::io::AsyncWriteExt;

#[derive(serde::Serialize)]
pub(super) struct ClaudeUserFrame<'a> {
    #[serde(rename = "type")]
    event_type: &'static str,
    uuid: String,
    parent_tool_use_id: Option<&'static str>,
    message: ClaudeUserMessage<'a>,
}

#[derive(serde::Serialize)]
struct ClaudeUserMessage<'a> {
    role: &'static str,
    content: &'a str,
}

fn claude_user_frame<'a>(uuid: &str, text: &'a str) -> ClaudeUserFrame<'a> {
    ClaudeUserFrame {
        event_type: "user",
        uuid: uuid.to_owned(),
        parent_tool_use_id: None,
        message: ClaudeUserMessage {
            role: "user",
            content: text,
        },
    }
}

#[cfg(test)]
pub(super) fn claude_initial_prompt_frame<'a>(
    run_id: &str,
    prompt: &'a str,
) -> ClaudeUserFrame<'a> {
    let uuid = crate::active_input::claude_initial_prompt_uuid(run_id);
    claude_user_frame(&uuid, prompt)
}

async fn write_claude_user_frame_to_stdin(
    stdin: &mut tokio::process::ChildStdin,
    uuid: &str,
    text: &str,
) -> Result<(), AgentError> {
    let mut line = serde_json::to_vec(&claude_user_frame(uuid, text))?;
    line.push(b'\n');
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    Ok(())
}

pub(super) async fn write_claude_stream_json_to_stdin(
    mut stdin: tokio::process::ChildStdin,
    run_id: &str,
    prompt: &str,
    mut active_input: ActiveInputWriter,
) -> Result<(), AgentError> {
    let initial_uuid = crate::active_input::claude_initial_prompt_uuid(run_id);
    write_claude_user_frame_to_stdin(&mut stdin, &initial_uuid, prompt).await?;
    if !active_input.is_enabled() {
        active_input.close_terminal();
        return Ok(());
    }

    while let Some(frame) = active_input.next_frame().await {
        active_input.mark_writing(&frame.uuid);
        if let Err(error) =
            write_claude_user_frame_to_stdin(&mut stdin, &frame.uuid, &frame.text).await
        {
            active_input.mark_backend_failed(&frame);
            return Err(error);
        }
        active_input.mark_backend_accepted_with_replay(&frame)?;
    }

    active_input.close_terminal();
    Ok(())
}
