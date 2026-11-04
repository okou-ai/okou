use super::*;

fn round_trip_commands() -> Vec<String> {
    vec![
        String::new(),
        "printf '%s\\n' one".to_string(),
        "printf \"%s\\n\" \"$HOME\"".to_string(),
        "printf '%s' '$LITERAL'".to_string(),
        "printf '%s' `uname`".to_string(),
        "printf one | sed 's/one/two/'; printf done".to_string(),
        "  leading and trailing  ".to_string(),
        "printf first\\nprintf second".replace("\\n", "\n"),
        "printf '你好，世界 🌍'".to_string(),
        "x".repeat(1024 * 1024),
    ]
}

#[test]
fn envelope_round_trips_losslessly_and_deterministically() {
    for command in round_trip_commands() {
        let first = encode_command_envelope(&command).unwrap();
        let second = encode_command_envelope(&command).unwrap();
        assert_eq!(first, second, "envelope must be deterministic");
        assert!(
            first
                .bytes()
                .all(|byte| { byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_') })
        );
        assert_eq!(decode_command_envelope(&first).unwrap(), command);
    }
}

#[test]
fn provider_command_decoder_accepts_direct_and_codex_outer_forms() {
    let original = "  printf '%s\\n' \"$HOME\" | sed 's/x/y/'; echo `date`\n你好  ";
    let managed = render_managed_shell_command(original).unwrap();
    for provider_command in [
        managed.clone(),
        format!("/bin/bash -c {managed}"),
        format!("/bin/bash -lc '{managed}'"),
        format!("/bin/bash -lc \"{managed}\""),
    ] {
        assert_eq!(
            decode_managed_shell_command(&provider_command).unwrap(),
            Some(original.to_string())
        );
    }
}

#[test]
fn ordinary_commands_remain_unwrapped() {
    for command in [
        "printf plain",
        "echo /usr/local/bin/guest-tool-exec",
        "printf '%s' 'exec /usr/local/bin/guest-tool-exec'",
        "/bin/bash -lc 'printf plain'",
        "printf '%s' '--command-envelope=vm0.command.v1.4.c2FmZQ'",
    ] {
        assert_eq!(decode_managed_shell_command(command).unwrap(), None);
    }
}

#[test]
fn malformed_truncated_and_unknown_envelopes_are_rejected() {
    let envelope = encode_command_envelope("printf safe").unwrap();
    let truncated = &envelope[..envelope.len() - 1];
    assert!(decode_command_envelope(truncated).is_err());
    assert_eq!(
        decode_command_envelope(&envelope.replace(".v1.", ".v2.")),
        Err(ManagedCommandError::UnsupportedVersion)
    );
    assert_eq!(
        decode_command_envelope("vm0.command.v1.4.***"),
        Err(ManagedCommandError::InvalidEnvelope)
    );
    assert_eq!(
        decode_command_envelope("vm0.command.v1.1.Zg=="),
        Err(ManagedCommandError::InvalidEnvelope)
    );
    assert_eq!(
        decode_command_envelope("vm0.command.v1.1.Zh"),
        Err(ManagedCommandError::InvalidEnvelope)
    );
    assert_eq!(
        decode_command_envelope("vm0.command.v1.04.c2FmZQ"),
        Err(ManagedCommandError::InvalidEnvelope)
    );

    let executable = format!("exec {TOOL_EXEC_PATH}");
    assert!(
        decode_managed_shell_command(&format!(
            "{executable} {COMMAND_ENVELOPE_ARGUMENT_PREFIX}{truncated} --shell \"$0\""
        ))
        .is_err()
    );
    assert_eq!(
        decode_managed_shell_command(&format!(
            "{executable} {COMMAND_ENVELOPE_ARGUMENT_PREFIX}{envelope}"
        )),
        Err(ManagedCommandError::InvalidInvocation)
    );
    assert_eq!(
        decode_managed_shell_command(&format!("{executable} --shell \"$0\"")),
        Err(ManagedCommandError::InvalidInvocation)
    );
    assert_eq!(
        decode_managed_shell_command(&format!(
            "/bin/bash -lc \"exec /tmp/not-managed {COMMAND_ENVELOPE_ARGUMENT_PREFIX}{envelope}\""
        )),
        Err(ManagedCommandError::InvalidInvocation)
    );
    assert_eq!(
        decode_managed_shell_command(&format!(
            "/bin/bash -lc \"exec '{TOOL_EXEC_PATH}' --shell \\\"\"'$0\" -c \"'\"'printf legacy'\""
        )),
        Err(ManagedCommandError::InvalidInvocation)
    );
}

#[test]
fn nul_is_rejected_on_both_sides_of_the_codec() {
    assert_eq!(
        encode_command_envelope("before\0after"),
        Err(ManagedCommandError::ContainsNul)
    );
    let encoded_nul = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"before\0after");
    assert_eq!(
        decode_command_envelope(&format!("vm0.command.v1.12.{encoded_nul}")),
        Err(ManagedCommandError::ContainsNul)
    );
}
