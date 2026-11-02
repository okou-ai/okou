use super::*;

fn manifest_json(cli: &str, runtime: &str, schema_version: u32) -> String {
    format!(
        r#"{{"schemaVersion":{schema_version},"versions":{{"cli":"{cli}","piAgentRuntime":"{runtime}","piSdk":"0.86.1+okou.abc"}},"package":{{"sha256":"{}","size":7}},"entrypoint":"/usr/local/lib/okou-cli/{cli}/okou.js"}}"#,
        "a".repeat(64)
    )
}

#[test]
fn parse_accepts_release_versions() {
    let manifest =
        InstalledOkouCli::parse(manifest_json("9.353.0", "1.36.0", 1).as_bytes()).unwrap();
    assert_eq!(manifest.versions.cli, "9.353.0");
    assert_eq!(manifest.versions.pi_agent_runtime, "1.36.0");
    assert_eq!(
        manifest.entrypoint,
        InstalledOkouCli::entrypoint_for("9.353.0")
    );
}

#[test]
fn parse_rejects_unknown_schema_and_loose_versions() {
    assert!(matches!(
        InstalledOkouCli::parse(manifest_json("9.353.0", "1.36.0", 2).as_bytes()),
        Err(InstalledOkouCliError::SchemaVersion(2))
    ));
    assert!(matches!(
        InstalledOkouCli::parse(manifest_json("v9.353.0", "1.36.0", 1).as_bytes()),
        Err(InstalledOkouCliError::Version { field: "cli", .. })
    ));
    assert!(matches!(
        InstalledOkouCli::parse(manifest_json("9.353.0", "1.36", 1).as_bytes()),
        Err(InstalledOkouCliError::Version {
            field: "piAgentRuntime",
            ..
        })
    ));
    assert!(InstalledOkouCli::parse(b"{").is_err());
}

#[test]
fn release_version_parsing_is_strict() {
    assert_eq!(parse_release_version("9.352.7"), Some([9, 352, 7]));
    assert_eq!(parse_release_version("0.0.0"), Some([0, 0, 0]));
    for invalid in [
        "9.352",
        "9.352.7.1",
        "9.352.07",
        "v9.352.7",
        "9.352.7-rc.1",
        "",
        "9..7",
    ] {
        assert_eq!(parse_release_version(invalid), None, "{invalid}");
    }
    assert!(parse_release_version("9.353.0") > parse_release_version("9.352.99"));
}
