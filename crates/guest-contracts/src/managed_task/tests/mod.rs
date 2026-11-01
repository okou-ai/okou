use super::*;

#[test]
fn handles_are_canonical_and_never_consumer_numbers() {
    let a = TaskHandle::generate();
    let b = TaskHandle::generate();
    assert_ne!(a, b);
    assert_eq!(TaskHandle::parse(a.as_str().into()).unwrap(), a);
    for invalid in [
        "1",
        "../runtime",
        "00000000-0000-0000-0000-00000000000A",
        "{00000000-0000-0000-0000-000000000000}",
    ] {
        assert!(TaskHandle::parse(invalid.into()).is_err());
    }
}

#[test]
fn nested_paths_are_exact_and_operation_owned() {
    let w = "/vm0-exec/exec-1-2/workload";
    let task = format!("{w}/tools/task-{}", TaskHandle::generate().as_str());
    for suffix in ["", "/runtime", "/tools", "/tools/tool-1"] {
        assert!(owned_task_path(&format!("{task}{suffix}"), w));
    }
    assert!(is_task_runtime_path(&format!("{task}/runtime")));
    let child = format!("{task}/tools/task-{}", TaskHandle::generate().as_str());
    let grandchild = format!("{child}/tools/task-{}", TaskHandle::generate().as_str());
    for parent in [&child, &grandchild] {
        for suffix in ["", "/runtime", "/tools", "/tools/tool-18446744073709551615"] {
            assert!(owned_task_path(&format!("{parent}{suffix}"), w));
        }
        assert!(is_task_runtime_path(&format!("{parent}/runtime")));
        assert!(!owned_task_path(&format!("{parent}/runtime/../tools"), w));
    }
    for suffix in [
        "/",
        "/runtime/",
        "/runtime/nested",
        "/tools/tool-1/../runtime",
        "/tools/tool-",
        "/tools/task-1/runtime",
        "/tools/tool-1-2",
    ] {
        assert!(!owned_task_path(&format!("{task}{suffix}"), w));
    }
    assert!(!owned_task_path(
        &format!("{task}/runtime"),
        "/vm0-exec/exec-1-20/workload"
    ));
    assert!(!is_task_runtime_path(
        "/vm0-exec/exec-1/workload/tools/tool-1/runtime"
    ));
    assert!(!is_task_runtime_path(&format!("{task}/tools/tool-1")));
}
