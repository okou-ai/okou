use std::collections::{HashMap, HashSet};

use runner_types::types::{Firewall, FirewallApi, FirewallAuth};
use serde::Deserialize;

const SUPPORTED_HOSTNAME_POLICY: &str = "vm0-uts46-16.0-v1";
const CONTRACT_JSON: &str = include_str!(
    "../../../turbo/packages/connectors/src/__tests__/firewall-base-url-validation-contract.json"
);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    hostname_policy: String,
    catalog_base_url_validation_cases: Vec<TestCase>,
    base_url_validation_cases: Vec<TestCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestCase {
    name: String,
    base: String,
    expected_valid: bool,
}

#[test]
fn firewall_base_url_validation_matches_shared_contract() {
    let contract: Contract = serde_json::from_str(CONTRACT_JSON)
        .expect("shared firewall base URL contract should parse");
    assert_eq!(
        contract.hostname_policy, SUPPORTED_HOSTNAME_POLICY,
        "shared firewall hostname policy changed without a runner compatibility review"
    );

    assert!(
        !contract.base_url_validation_cases.is_empty()
            && !contract.catalog_base_url_validation_cases.is_empty(),
        "shared firewall base URL contract should contain runtime and catalog cases"
    );

    let cases: Vec<TestCase> = contract
        .base_url_validation_cases
        .into_iter()
        .chain(contract.catalog_base_url_validation_cases)
        .collect();

    let mut names = HashSet::new();
    let mismatches: Vec<String> = cases
        .into_iter()
        .filter_map(|test_case| {
            assert!(
                names.insert(test_case.name.clone()),
                "shared firewall base URL contract contains duplicate case {:?}",
                test_case.name
            );
            let result = firewall(test_case.base.clone()).validate_for_cache();
            (result.is_ok() != test_case.expected_valid).then(|| {
                format!(
                    "shared case {:?} produced unexpected result for {:?}: {:?}",
                    test_case.name,
                    test_case.base,
                    result.err()
                )
            })
        })
        .collect();

    assert!(
        mismatches.is_empty(),
        "firewall base URL contract mismatches:\n{}",
        mismatches.join("\n")
    );
}

fn firewall(base: String) -> Firewall {
    Firewall {
        name: "contract-test".to_string(),
        apis: vec![FirewallApi {
            id: String::new(),
            base,
            auth: FirewallAuth {
                headers: HashMap::new(),
                base: None,
                query: None,
                aws_sigv4: None,
            },
            host_policy: None,
            permissions: None,
        }],
    }
}
