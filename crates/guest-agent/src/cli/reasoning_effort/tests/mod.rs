use super::*;

#[test]
fn rejects_efforts_outside_the_harness_vocabulary() {
    for (framework, effort) in [
        (Framework::Codex, "extra"),
        (Framework::Codex, "ultracode"),
        (Framework::Codex, ""),
        (Framework::ClaudeCode, "xhigh"),
        (Framework::ClaudeCode, "ultra"),
        (Framework::ClaudeCode, ""),
    ] {
        let env = HashMap::from([("OKOU_REASONING_EFFORT".to_string(), effort.to_string())]);
        assert!(resolve(framework, &env).is_err(), "{framework:?}: {effort}");
    }
}

#[test]
fn accepts_harness_efforts_for_any_catalog_model() {
    for (framework, model_key, model, effort, expected) in [
        (
            Framework::ClaudeCode,
            "ANTHROPIC_MODEL",
            "claude-haiku-5-5",
            "medium",
            "medium",
        ),
        (
            Framework::ClaudeCode,
            "ANTHROPIC_MODEL",
            "claude-haiku-5-5",
            "extra",
            "xhigh",
        ),
        (
            Framework::Codex,
            "OPENAI_MODEL",
            "openai/gpt-7",
            "ultra",
            "ultra",
        ),
    ] {
        let env = HashMap::from([
            (model_key.to_string(), model.to_string()),
            ("OKOU_REASONING_EFFORT".to_string(), effort.to_string()),
        ]);
        assert_eq!(
            resolve(framework, &env).ok().flatten(),
            Some(expected),
            "{model}: {effort}"
        );
    }
}
