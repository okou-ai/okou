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

#[test]
fn firewall_cache_validation_rejects_parameterized_ipv4_hosts() {
    for base in [
        "https://127.{octet}",
        "https://127.0.{a}.{b}",
        "https://127.0.0.1{suffix}",
        "https://{octets+}.0.0.{suffix}1",
        "https://{octets*}.0.0.{suffix}1",
        "https://{octet}.0x1",
        "https://{prefix}7.0.0.1",
        "https://1{octet}7.0.0.1",
        "https://{sub*}.127.0.0.1",
        "https://{sub*}.127.0.0.1{suffix}",
    ] {
        let result = firewall(base.to_string()).validate_for_cache();
        assert!(result.is_err(), "IPv4 host template {base:?} was accepted");
    }
}

#[test]
fn firewall_cache_validation_preserves_valid_numeric_hosts() {
    for base in [
        "https://{sub}.123.example.com",
        "https://{sub}.0123.example.com",
        "https://{sub}.0XABC.example.com",
        "https://api-{sub}.123.example.com",
        "https://{sub+}.0123.example.com",
        "https://{sub*}.0xabc.example.com",
        "https://1.2.3.4.{sub}",
        "https://127.0.{octet}.node-{suffix}",
        "https://{sub+}.127.0.0.1{suffix}",
        "https://127.0.0.1/{path}",
    ] {
        let result = firewall(base.to_string()).validate_for_cache();
        assert!(
            result.is_ok(),
            "valid host template {base:?} was rejected: {result:?}"
        );
    }
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
