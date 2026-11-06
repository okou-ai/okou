use std::borrow::Cow;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{NetworkPolicy, RunnerResult, capacity};

/// A registration-local view with the same four serialized policy fields.
/// Serde borrows unescaped names and owns decoded escaped names. Other registry
/// fields keep their existing types and validation, including model JSON numbers.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Policy<'a> {
    #[serde(borrow)]
    allow: Vec<Permission<'a>>,
    #[serde(borrow)]
    deny: Vec<Permission<'a>>,
    #[serde(borrow)]
    ask: Vec<Permission<'a>>,
    #[serde(borrow)]
    unknown_policy: Cow<'a, str>,
}

#[derive(Serialize, Deserialize)]
struct Permission<'a>(#[serde(borrow)] Cow<'a, str>);

impl AsRef<str> for Permission<'_> {
    fn as_ref(&self) -> &str {
        self.0.as_ref()
    }
}

impl capacity::PolicyCapacity for Policy<'_> {
    fn capacity_growth(&self) -> RunnerResult<u64> {
        capacity::arrays_growth([&self.allow, &self.deny, &self.ask], &self.unknown_policy)
    }
}

pub(super) fn policies(values: &HashMap<String, NetworkPolicy>) -> HashMap<String, Policy<'_>> {
    values
        .iter()
        .map(|(name, policy)| {
            (
                name.clone(),
                Policy {
                    allow: permissions(&policy.allow),
                    deny: permissions(&policy.deny),
                    ask: permissions(&policy.ask),
                    unknown_policy: Cow::Borrowed(&policy.unknown_policy),
                },
            )
        })
        .collect()
}

fn permissions(names: &[String]) -> Vec<Permission<'_>> {
    names
        .iter()
        .map(|name| Permission(Cow::Borrowed(name)))
        .collect()
}
