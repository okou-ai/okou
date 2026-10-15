use crate::transcript::{
    JsonlTranscript, generate_session_id, init_event, replayed_user_event, result_event,
};
use serde_json::Value;
use std::io::{BufRead, Read, Write};
use std::process::ExitCode;

const ACTIVE_INPUT_READY_RESULT: &str = "READY_FOR_ACTIVE_INPUT";

#[derive(Debug)]
pub(super) struct StreamJsonUserFrame {
    content: String,
    uuid: Option<String>,
}

impl StreamJsonUserFrame {
    pub(super) fn content(&self) -> &str {
        &self.content
    }
}

#[derive(Clone, Copy)]
enum StreamJsonFrameKind {
    First,
    FollowUp { index: usize },
}

pub(super) fn read_initial_user_frame(
    reader: &mut impl BufRead,
) -> Result<Option<StreamJsonUserFrame>, String> {
    read_next_stream_json_user_frame(reader, StreamJsonFrameKind::First)
}

pub(super) fn invalid_count_message(marker: &str, count: &str) -> String {
    format!("invalid {marker} follow-up count ({} bytes)", count.len())
}

fn read_next_stream_json_user_frame(
    reader: &mut impl BufRead,
    kind: StreamJsonFrameKind,
) -> Result<Option<StreamJsonUserFrame>, String> {
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|e| format!("read stream-json stdin: {e}"))?;
        if bytes == 0 {
            return Ok(None);
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        return parse_stream_json_user_frame(trimmed, kind).map(Some);
    }
}

fn parse_stream_json_user_frame(
    line: &str,
    kind: StreamJsonFrameKind,
) -> Result<StreamJsonUserFrame, String> {
    let event: Value = serde_json::from_str(line).map_err(|e| match kind {
        StreamJsonFrameKind::First => format!("parse stream-json stdin: {e}"),
        StreamJsonFrameKind::FollowUp { index } => {
            format!("parse stream-json stdin follow-up message {index}: {e}")
        }
    })?;

    let description = match kind {
        StreamJsonFrameKind::First => "first message".to_string(),
        StreamJsonFrameKind::FollowUp { index } => format!("follow-up message {index}"),
    };

    if event.get("type").and_then(Value::as_str) != Some("user") {
        return Err(format!(
            "stream-json stdin {description} must have type \"user\""
        ));
    }
    if let Some(role) = event.pointer("/message/role").and_then(Value::as_str)
        && role != "user"
    {
        return Err(format!(
            "stream-json stdin {description} role must be \"user\""
        ));
    }

    let content = event
        .pointer("/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            format!("stream-json stdin {description} must contain string message.content")
        })?;
    let uuid = event
        .get("uuid")
        .and_then(Value::as_str)
        .map(str::to_string);

    Ok(StreamJsonUserFrame { content, uuid })
}

pub(super) fn run_active_input_smoke_scenario(
    output_format: &str,
    replay_user_messages: bool,
    initial_frame: StreamJsonUserFrame,
    stdin: &mut impl BufRead,
    expected_follow_ups: usize,
    ready_after_first_follow_up: bool,
) -> ExitCode {
    if output_format != "stream-json" {
        eprintln!("@active-input-smoke requires --output-format stream-json");
        return ExitCode::from(1);
    }

    let session_id = generate_session_id();
    let mut transcript = JsonlTranscript::default();

    transcript.emit_value(init_event(&session_id, &["Bash"]));
    if replay_user_messages {
        transcript.emit_value(replayed_user_event(
            &session_id,
            initial_frame.uuid.as_deref(),
            &initial_frame.content,
        ));
    }
    let mut follow_up_contents = Vec::new();
    let mut next_follow_up_index = 1;
    if ready_after_first_follow_up {
        let first_frame =
            match read_follow_up_frame(stdin, 1, follow_up_contents.len(), expected_follow_ups) {
                Ok(frame) => frame,
                Err(exit_code) => return exit_code,
            };

        transcript.emit_value(result_event(&session_id, false, ACTIVE_INPUT_READY_RESULT));
        let _ = std::io::stdout().flush();
        emit_follow_up(
            &mut transcript,
            &session_id,
            replay_user_messages,
            first_frame,
            &mut follow_up_contents,
        );
        next_follow_up_index = 2;
    } else {
        transcript.emit_value(result_event(&session_id, false, ACTIVE_INPUT_READY_RESULT));
        let _ = std::io::stdout().flush();
    }

    for index in next_follow_up_index..=expected_follow_ups {
        let frame =
            match read_follow_up_frame(stdin, index, follow_up_contents.len(), expected_follow_ups)
            {
                Ok(frame) => frame,
                Err(exit_code) => return exit_code,
            };
        emit_follow_up(
            &mut transcript,
            &session_id,
            replay_user_messages,
            frame,
            &mut follow_up_contents,
        );
    }

    // A channel fixture can keep the run active until its host has received
    // every control ACK, even when the mock consumes the last input first.
    if let Some(path) = std::env::var_os("MOCK_CLAUDE_ACTIVE_INPUT_COMPLETION_FIFO") {
        let released =
            std::fs::File::open(path).and_then(|mut fifo| fifo.read_exact(&mut [0_u8; 1]));
        if let Err(error) = released {
            eprintln!("active-input completion gate failed: {error}");
            return ExitCode::from(1);
        }
    }

    transcript.emit_value(result_event(
        &session_id,
        false,
        &format!("RESULT={}", follow_up_contents.join("+")),
    ));
    transcript.write_session_history(&session_id);
    let _ = std::io::stdout().flush();
    ExitCode::SUCCESS
}

fn read_follow_up_frame(
    reader: &mut impl BufRead,
    index: usize,
    received_follow_ups: usize,
    expected_follow_ups: usize,
) -> Result<StreamJsonUserFrame, ExitCode> {
    match read_next_stream_json_user_frame(reader, StreamJsonFrameKind::FollowUp { index }) {
        Ok(Some(frame)) => Ok(frame),
        Ok(None) => {
            eprintln!(
                "active-input stdin closed after {received_follow_ups} of {expected_follow_ups} follow-up user messages"
            );
            Err(ExitCode::from(1))
        }
        Err(message) => {
            eprintln!("{message}");
            Err(ExitCode::from(1))
        }
    }
}

fn emit_follow_up(
    transcript: &mut JsonlTranscript,
    session_id: &str,
    replay_user_messages: bool,
    frame: StreamJsonUserFrame,
    follow_up_contents: &mut Vec<String>,
) {
    if replay_user_messages {
        transcript.emit_value(replayed_user_event(
            session_id,
            frame.uuid.as_deref(),
            &frame.content,
        ));
        let _ = std::io::stdout().flush();
    }
    follow_up_contents.push(frame.content);
}
