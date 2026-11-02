use super::*;
use std::process::Command;

#[test]
fn quotes_empty_string() {
    assert_eq!(quote_shell_arg(""), "''");
}

#[test]
fn quotes_plain_text() {
    assert_eq!(quote_shell_arg("hello"), "'hello'");
}

#[test]
fn quotes_whitespace() {
    assert_eq!(quote_shell_arg("hello world"), "'hello world'");
}

#[test]
fn escapes_embedded_single_quotes() {
    assert_eq!(quote_shell_arg("it's"), "'it'\\''s'");
}

#[test]
fn quotes_shell_metacharacters() {
    assert_eq!(quote_shell_arg("$HOME"), "'$HOME'");
}

#[test]
fn quotes_command_separators() {
    assert_eq!(quote_shell_arg("ok; uname -a"), "'ok; uname -a'");
}

#[test]
fn quotes_expansion_and_redirection_syntax() {
    assert_eq!(quote_shell_arg("$(uname)"), "'$(uname)'");
    assert_eq!(quote_shell_arg("`uname`"), "'`uname`'");
    assert_eq!(quote_shell_arg("*"), "'*'");
    assert_eq!(quote_shell_arg("x > out"), "'x > out'");
}

#[test]
fn preserves_newlines_inside_quoted_word() {
    assert_eq!(quote_shell_arg("line1\nline2"), "'line1\nline2'");
}

#[test]
fn quotes_unicode_text() {
    assert_eq!(quote_shell_arg("hello 世界"), "'hello 世界'");
}

#[test]
fn quotes_safe_punctuation() {
    assert_eq!(quote_shell_arg("/tmp/a-b.c:+@%"), "'/tmp/a-b.c:+@%'");
}

#[test]
fn quotes_assignment_like_words() {
    assert_eq!(quote_shell_arg("FOO=bar"), "'FOO=bar'");
}

#[test]
fn quotes_shell_reserved_words() {
    assert_eq!(quote_shell_arg("if"), "'if'");
}

#[test]
fn quoted_words_round_trip_through_posix_shell() {
    for value in [
        "",
        "plain",
        "with space",
        "it's",
        "'starts",
        "ends'",
        "a'b'c",
        "$HOME",
        "$(uname)",
        "`uname`",
        "*",
        "x > out",
        "ok; uname -a",
        "line1\nline2",
        "tab\tseparated",
        "carriage\rreturn",
        "hello 世界",
        "/tmp/a-b.c:+@%",
        "FOO=bar",
        "if",
    ] {
        let command = format!("printf '%s' {}", quote_shell_arg(value));
        let output = Command::new("sh")
            .arg("-c")
            .arg(&command)
            .output()
            .unwrap_or_else(|error| panic!("failed to run shell for {value:?}: {error}"));

        assert!(
            output.status.success(),
            "shell failed for {value:?} via {command:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout)
                .unwrap_or_else(|error| panic!("non-UTF-8 shell output: {error}")),
            value
        );
    }
}

#[test]
fn all_non_nul_ascii_bytes_round_trip_through_posix_shell() {
    let value = String::from_utf8((1_u8..=127).collect()).expect("ASCII is valid UTF-8");
    let command = format!("printf '%s' {}", quote_shell_arg(&value));
    let output = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .output()
        .unwrap_or_else(|error| panic!("failed to run shell: {error}"));

    assert!(
        output.status.success(),
        "shell failed via {command:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, value.as_bytes());
}

#[test]
fn composed_quoted_words_keep_argument_boundaries_through_posix_shell() {
    let values = ["", "with space", "it's", "$(uname)", "*", "line1\nline2"];
    let command = format!(
        "set -- {}; printf '%s\\037' \"$@\"",
        values
            .iter()
            .map(|value| quote_shell_arg(value))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let output = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .output()
        .unwrap_or_else(|error| panic!("failed to run shell: {error}"));

    assert!(
        output.status.success(),
        "shell failed via {command:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected = values.join("\x1f") + "\x1f";
    assert_eq!(output.stdout, expected.as_bytes());
}
