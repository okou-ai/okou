//! Content-addressable storage hash — Rust port of the shared TypeScript
//! contract at `turbo/packages/api-contracts/src/contracts/storage-content-hash.ts`.
//!
//! `version_id` in VAS *is* this hash — the TS function is the sole producer
//! across every prepare/commit route. Guest-side we recompute it locally so
//! the checkpoint step can skip the prepare+commit round-trips when the
//! artifact is unchanged since mount (see issue #10967).
//!
//! The two implementations must stay byte-identical. The inline `#[cfg(test)]`
//! suite below shares its canonical fixture corpus with the TypeScript tests;
//! changes here must be checked against TS `computeContentHashFromHashes`.

use sha2::{Digest, Sha256};

#[derive(Clone, Copy)]
struct ContentHashEntry<'a> {
    path: &'a str,
    hash: &'a str,
}

struct SortableContentHashEntry<'a> {
    entry: ContentHashEntry<'a>,
    sort_key: Vec<u16>,
}

impl<'a> SortableContentHashEntry<'a> {
    fn new(entry: ContentHashEntry<'a>) -> Self {
        Self {
            entry,
            sort_key: formatted_entry_sort_key(entry),
        }
    }
}

/// Compute the content hash for a storage version.
///
/// Format matches the TS reference:
/// - empty files: `sha256("storage:<id>\n")`
/// - non-empty: `sha256("storage:<id>\n<path>:<hash>\n<path>:<hash>…")`
///   with formatted entries sorted like JS's default `Array.sort()`.
///
/// JS default string sorting compares UTF-16 code units. Rust must mirror that
/// rule exactly, then still hash the selected formatted entries as UTF-8 bytes.
pub(crate) fn compute_content_hash<'a, I>(storage_id: &str, files: I) -> String
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut hasher = Sha256::new();
    hasher.update(b"storage:");
    hasher.update(storage_id.as_bytes());
    hasher.update(b"\n");

    let mut entries = files
        .into_iter()
        .map(|(path, hash)| ContentHashEntry { path, hash });
    let Some(first_entry) = entries.next() else {
        return hex::encode(hasher.finalize());
    };
    let Some(second_entry) = entries.next() else {
        update_hash_for_entry(&mut hasher, 0, first_entry);
        return hex::encode(hasher.finalize());
    };

    let (remaining_lower_bound, _) = entries.size_hint();
    let mut sortable_entries = Vec::with_capacity(remaining_lower_bound.saturating_add(2));
    sortable_entries.push(SortableContentHashEntry::new(first_entry));
    sortable_entries.push(SortableContentHashEntry::new(second_entry));
    sortable_entries.extend(entries.map(SortableContentHashEntry::new));
    // Equal sort keys are identical formatted `path:hash` lines, so stability
    // cannot affect the final hash byte stream.
    sortable_entries.sort_unstable_by(|left, right| left.sort_key.cmp(&right.sort_key));
    for (index, entry) in sortable_entries.iter().enumerate() {
        update_hash_for_entry(&mut hasher, index, entry.entry);
    }

    hex::encode(hasher.finalize())
}

fn update_hash_for_entry(hasher: &mut Sha256, index: usize, entry: ContentHashEntry<'_>) {
    if index > 0 {
        hasher.update(b"\n");
    }
    hasher.update(entry.path.as_bytes());
    hasher.update(b":");
    hasher.update(entry.hash.as_bytes());
}

fn formatted_entry_sort_key(entry: ContentHashEntry<'_>) -> Vec<u16> {
    let mut sort_key = Vec::with_capacity(entry.path.len() + 1 + entry.hash.len());
    sort_key.extend(entry.path.encode_utf16());
    sort_key.push(u16::from(b':'));
    sort_key.extend(entry.hash.encode_utf16());
    sort_key
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const CONTENT_HASH_CONTRACT: &str = include_str!(
        "../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/storage-content-hash.json"
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
}
