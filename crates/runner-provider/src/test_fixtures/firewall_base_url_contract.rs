use std::collections::HashSet;

use serde::Deserialize;

const SUPPORTED_HOSTNAME_POLICY: &str = "vm0-uts46-16.0-v1";
const CONTRACT_JSON: &str = include_str!(
    "../../../../turbo/packages/connectors/src/__tests__/firewall-base-url-validation-contract.json"
);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FirewallBaseUrlValidationContract {
    hostname_policy: String,
    catalog_base_url_validation_cases: Vec<FirewallBaseUrlValidationCase>,
    base_url_validation_cases: Vec<FirewallBaseUrlValidationCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirewallBaseUrlValidationCase {
    pub(crate) name: String,
    pub(crate) base: String,
    pub(crate) expected_valid: bool,
}

pub(crate) fn firewall_base_url_validation_cases() -> Vec<FirewallBaseUrlValidationCase> {
    let contract = load_contract();
    contract
        .base_url_validation_cases
        .into_iter()
        .chain(contract.catalog_base_url_validation_cases)
        .collect()
}

pub(crate) fn catalog_firewall_base_url_validation_cases() -> Vec<FirewallBaseUrlValidationCase> {
    load_contract().catalog_base_url_validation_cases
}

fn load_contract() -> FirewallBaseUrlValidationContract {
    let contract: FirewallBaseUrlValidationContract = serde_json::from_str(CONTRACT_JSON)
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

    let mut names = HashSet::new();
    for test_case in contract
        .base_url_validation_cases
        .iter()
        .chain(&contract.catalog_base_url_validation_cases)
    {
        assert!(
            names.insert(test_case.name.as_str()),
            "shared firewall base URL contract contains duplicate case {:?}",
            test_case.name
        );
    }

    contract
}
