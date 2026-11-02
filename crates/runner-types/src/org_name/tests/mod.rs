use super::*;

#[test]
fn accepts_contract_language() {
    for name in [
        "vm0/prod",
        "test/group",
        "acme/my-resource-1",
        "123/456",
        "-vm0/prod",
        "vm0/prod-",
        "-/--",
    ] {
        assert!(is_valid(name), "expected {name:?} to be valid");
    }
}

#[test]
fn rejects_names_outside_contract_language() {
    for name in [
        "",
        "default",
        "/default",
        "vm0/",
        "vm0/my/nested",
        "VM0/prod",
        "vm0/Prod",
        "vm0/pr od",
        "vm0/prod_1",
        "vm0/pröd",
        "组织/prod",
        "..",
        "../etc",
        "vm0/../etc",
        "/etc",
        "/etc/passwd",
        ".",
        "vm0/.",
        "vm0/..",
        r"vm0\prod",
    ] {
        assert!(!is_valid(name), "expected {name:?} to be invalid");
    }
}
