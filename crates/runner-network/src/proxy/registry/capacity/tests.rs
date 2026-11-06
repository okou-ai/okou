use super::*;

fn assert_matches_serialized_transition(policy: &NetworkPolicy) {
    let current = serde_json::to_vec(policy).unwrap().len();
    let closed = serde_json::to_vec(&super::super::fail_closed_policy(policy))
        .unwrap()
        .len();
    assert_eq!(
        policy_growth(policy).unwrap(),
        closed.saturating_sub(current) as u64,
        "policy: {policy:?}"
    );
}

#[test]
fn capacity_matches_actual_fail_closed_bytes_for_string_and_duplicate_boundaries() {
    let atoms = ["", "read", "\"", "\\", "\n", "\u{0}", "雪", "😀"];
    let mut lists = vec![Vec::new()];
    for atom in atoms {
        lists.push(vec![atom.to_string()]);
        lists.push(vec![atom.to_string(), atom.to_string()]);
    }
    for allow in &lists {
        for deny in &lists {
            for ask in &lists {
                for unknown_policy in ["allow", "deny", "ask", "", "x", "\"", "\n", "雪"] {
                    assert_matches_serialized_transition(&NetworkPolicy {
                        allow: allow.clone(),
                        deny: deny.clone(),
                        ask: ask.clone(),
                        unknown_policy: unknown_policy.into(),
                    });
                }
            }
        }
    }
}

#[test]
fn capacity_preserves_mixed_array_growth_and_long_policy_strings() {
    for unknown_policy in ["allow", "deny", "ask", "", "arbitrary stored value"] {
        for duplicate in [false, true] {
            let allow = (0..256).map(|i| format!("permission.{i}")).collect();
            let deny = (256..512).map(|i| format!("permission.{i}")).collect();
            let mut ask = vec!["permission.\"escaped\"\n雪".repeat(1024)];
            if duplicate {
                ask.push("permission.17".into());
            }
            assert_matches_serialized_transition(&NetworkPolicy {
                allow,
                deny,
                ask,
                unknown_policy: unknown_policy.into(),
            });
        }
    }
}
