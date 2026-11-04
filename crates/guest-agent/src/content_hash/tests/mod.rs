use super::*;
use serde::Deserialize;

const CONTENT_HASH_CONTRACT: &str = include_str!(
    "../../../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/storage-content-hash.json"
);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentHashFixture {
    name: String,
    storage_id: String,
    files: Vec<ContentHashFixtureFile>,
    expected: String,
}

#[derive(Deserialize)]
struct ContentHashFixtureFile {
    path: String,
    hash: String,
}

#[test]
fn matches_shared_content_hash_contract() {
    let fixtures: Vec<ContentHashFixture> = serde_json::from_str(CONTENT_HASH_CONTRACT)
        .expect("shared content hash contract should parse");
    assert!(
        !fixtures.is_empty(),
        "shared content hash contract should contain fixtures"
    );

    for fixture in fixtures {
        let got = compute_content_hash(
            &fixture.storage_id,
            fixture
                .files
                .iter()
                .map(|file| (file.path.as_str(), file.hash.as_str())),
        );
        assert_eq!(got, fixture.expected, "fixture {:?}", fixture.name);
    }
}
