use std::collections::HashSet;

use super::{NetworkPolicy, RunnerError, RunnerResult};

pub(super) trait PolicyCapacity: serde::Serialize {
    fn capacity_growth(&self) -> RunnerResult<u64>;
}

impl PolicyCapacity for NetworkPolicy {
    fn capacity_growth(&self) -> RunnerResult<u64> {
        policy_growth(self)
    }
}

/// Exact JSON growth when the four-field policy becomes fail-closed.
///
/// Field names and array brackets cancel. Combining k nonempty arrays adds k-1
/// commas; each removed duplicate subtracts its encoded string plus one comma.
/// The final unknownPolicy is the six-byte JSON string `"deny"`. This measures
/// capacity only; actual policy transitions still use `fail_closed_policy`.
pub(super) fn policy_growth(policy: &NetworkPolicy) -> RunnerResult<u64> {
    arrays_growth(
        [&policy.allow, &policy.deny, &policy.ask],
        &policy.unknown_policy,
    )
}

pub(super) fn arrays_growth<S: AsRef<str>>(
    arrays: [&[S]; 3],
    unknown_policy: &str,
) -> RunnerResult<u64> {
    let populated = arrays.iter().filter(|array| !array.is_empty()).count();
    let closed_overhead = 6 + populated.saturating_sub(1);

    // JSON quotes add at least two bytes. Long/escaped unknown strings cannot
    // produce positive growth; do not encode a potentially large stored value.
    if unknown_policy.len() >= closed_overhead - 2 {
        return Ok(0);
    }
    let unknown_bytes = encoded_string_len(unknown_policy)?;
    let mut growth = closed_overhead.saturating_sub(unknown_bytes);
    if growth == 0 {
        return Ok(0);
    }

    let mut names = HashSet::new();
    for name in arrays.into_iter().flatten() {
        let name = name.as_ref();
        if names.insert(name) {
            continue;
        }
        // A duplicate removes its quotes, bytes and comma. The initial growth
        // is at most six, so normally this lower bound already exhausts it.
        if name.len() >= growth.saturating_sub(3) {
            return Ok(0);
        }
        growth = growth.saturating_sub(encoded_string_len(name)? + 1);
        if growth == 0 {
            return Ok(0);
        }
    }
    Ok(growth as u64)
}

fn encoded_string_len(value: &str) -> RunnerResult<usize> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|error| RunnerError::Internal(format!("serialize network policy: {error}")))
}

#[cfg(test)]
mod tests;
