use super::*;

#[test]
fn canonical_tool_endpoint_presence_selects_the_managed_launcher() {
    let endpoint = OsStr::new("endpoint");
    let empty = OsStr::new("");

    assert_eq!(bash_tool_binary(None), "bash");
    assert_eq!(bash_tool_binary(Some(endpoint)), TOOL_EXEC_PATH);
    assert_eq!(bash_tool_binary(Some(empty)), TOOL_EXEC_PATH);
}
