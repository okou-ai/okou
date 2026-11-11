mod fresh_claim;
mod preferred_blank;
mod stale_journal;

use super::*;

#[test]
fn ranked_preference_admission_matrix() {
    use RunnerPreferenceTier::{ExactSandbox, FinalizingPredecessor, HomeCache, ReusableSandbox};

    let tiers = [
        HomeCache,
        ReusableSandbox,
        FinalizingPredecessor,
        ExactSandbox,
    ];
    let selected = [
        [true, true, true, true],
        [false, true, true, true],
        [false, false, true, true],
        [false, false, false, true],
    ];
    let unselected = [
        [false, true, true, true],
        [false, false, true, true],
        [false, false, false, true],
        [false, false, false, false],
    ];

    for ((advertised_tier, selected_row), unselected_row) in
        tiers.into_iter().zip(selected).zip(unselected)
    {
        for ((local_tier, selected_expected), unselected_expected) in
            tiers.into_iter().zip(selected_row).zip(unselected_row)
        {
            assert_eq!(
                ranked_preference_allows(advertised_tier, local_tier, true),
                selected_expected,
                "selected runner: advertised={advertised_tier:?}, local={local_tier:?}"
            );
            assert_eq!(
                ranked_preference_allows(advertised_tier, local_tier, false),
                unselected_expected,
                "unselected runner: advertised={advertised_tier:?}, local={local_tier:?}"
            );
        }
    }
}
