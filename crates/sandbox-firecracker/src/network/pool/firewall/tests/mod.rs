use super::*;

#[test]
fn xtables_args_prepends_bare_wait() {
    assert_eq!(
        xtables_args(&["=", "--wait"]),
        vec!["--wait", "=", "--wait"]
    );
}

#[test]
fn firewall_restore_builds_apply_payload_for_insert_and_append_rules() {
    let payload = firewall_restore_payload(
        &[
            FirewallRestoreTable {
                table: "raw",
                rules: vec!["-I PREROUTING 1 -m comment --comment vm0-ns-00-00 -j DROP".into()],
            },
            FirewallRestoreTable {
                table: "filter",
                rules: vec!["-A FORWARD -m comment --comment vm0-ns-00-00 -j ACCEPT".into()],
            },
        ],
        FirewallRestoreMode::Apply,
    )
    .unwrap();

    assert_eq!(
        payload,
        "*raw\n-I PREROUTING 1 -m comment --comment vm0-ns-00-00 -j DROP\nCOMMIT\n*filter\n-A FORWARD -m comment --comment vm0-ns-00-00 -j ACCEPT\nCOMMIT\n"
    );
}

#[test]
fn firewall_restore_batches_tables_in_one_delete_payload() {
    let payload = firewall_restore_payload(
        &[
            FirewallRestoreTable {
                table: "raw",
                rules: vec!["-A PREROUTING -m comment --comment vm0-ns-00-00 -j DROP".into()],
            },
            FirewallRestoreTable {
                table: "nat",
                rules: Vec::new(),
            },
            FirewallRestoreTable {
                table: "filter",
                rules: vec!["-A FORWARD -m comment --comment vm0-ns-00-00 -j ACCEPT".into()],
            },
        ],
        FirewallRestoreMode::Delete,
    )
    .unwrap();

    assert_eq!(
        payload,
        "*raw\n-D PREROUTING -m comment --comment vm0-ns-00-00 -j DROP\nCOMMIT\n*filter\n-D FORWARD -m comment --comment vm0-ns-00-00 -j ACCEPT\nCOMMIT\n"
    );
}

#[tokio::test]
async fn firewall_restore_nonzero_is_abandoned() {
    let outcome = delete_firewall_rules_with_restore(
        "false",
        vec![FirewallRestoreTable {
            table: "raw",
            rules: vec!["-A PREROUTING -j DROP".into()],
        }],
    )
    .await;

    assert_eq!(outcome, NamespaceDeleteOutcome::Abandoned);
}

#[test]
fn incomplete_snapshot_preserves_captured_delete_payload_and_remains_abandoned() {
    let captured = FirewallTableSnapshot {
        table: "raw",
        rules_by_pool: SnapshotSource::Captured(BTreeMap::from([(
            0,
            vec!["-A PREROUTING -m comment --comment vm0-ns-00-00 -j DROP".into()],
        )])),
    };
    let abandoned = FirewallTableSnapshot {
        table: "filter",
        rules_by_pool: SnapshotSource::Abandoned,
    };
    let selection = firewall_restore_tables_for_pool([&captured, &abandoned], 0);

    assert_eq!(selection.source_outcome, NamespaceDeleteOutcome::Abandoned);
    assert_eq!(
        firewall_restore_payload(&selection.tables, FirewallRestoreMode::Delete).unwrap(),
        "*raw\n-D PREROUTING -m comment --comment vm0-ns-00-00 -j DROP\nCOMMIT\n"
    );
}
