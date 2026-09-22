use std::collections::{HashMap, HashSet};

use runner_types::types::{
    Firewall, FirewallApi, FirewallAuth, FirewallAwsSigv4Auth, FirewallPermission,
};
use serde::Deserialize;

const CONTRACT_JSON: &str = include_str!(
    "../../../turbo/packages/connectors/src/__tests__/firewall-semantics-contract.json"
);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    aws_rule_validation_cases: Vec<TestCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestCase {
    name: String,
    rule: String,
    valid: bool,
}

#[test]
fn firewall_rule_validation_matches_shared_contract() {
    let contract: Contract = serde_json::from_str(CONTRACT_JSON)
        .expect("shared firewall semantics contract should parse");
    assert!(
        !contract.aws_rule_validation_cases.is_empty(),
        "shared firewall semantics contract should contain AWS rule cases"
    );

    let mut names = HashSet::new();
    let mismatches: Vec<String> = contract
        .aws_rule_validation_cases
        .into_iter()
        .filter_map(|test_case| {
            assert!(
                names.insert(test_case.name.clone()),
                "shared firewall semantics contract contains duplicate AWS case {:?}",
                test_case.name
            );
            let result = firewall(test_case.rule.clone()).validate_for_cache();
            (result.is_ok() != test_case.valid).then(|| {
                format!(
                    "shared case {:?} produced unexpected result for {:?}: {:?}",
                    test_case.name,
                    test_case.rule,
                    result.err()
                )
            })
        })
        .collect();

    assert!(
        mismatches.is_empty(),
        "firewall rule contract mismatches:\n{}",
        mismatches.join("\n")
    );
}

fn firewall(rule: String) -> Firewall {
    Firewall {
        name: "contract-test".to_string(),
        apis: vec![FirewallApi {
            id: String::new(),
            base: "https://ec2.us-east-1.amazonaws.com".to_string(),
            auth: FirewallAuth {
                headers: HashMap::new(),
                base: None,
                query: None,
                aws_sigv4: Some(FirewallAwsSigv4Auth {
                    access_key_id: "access-key".to_string(),
                    secret_access_key: "secret-key".to_string(),
                    session_token: None,
                }),
            },
            host_policy: None,
            permissions: Some(vec![FirewallPermission {
                name: "contract-test".to_string(),
                description: None,
                rules: vec![rule],
            }]),
        }],
    }
}
