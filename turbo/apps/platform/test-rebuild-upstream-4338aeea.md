# Upstream reconciliation through 4338aeea

[#49278](https://github.com/okou-ai/okou/pull/49278) removes the pre-draft API
rollback target and its dedicated Platform registration. Frozen
`onboarding-progress-005` was selected before that retirement. Keep its
frozen inventory and BDD intact for accounting. Its original Given requires an
older API that can no longer serve during deployment or rollback. The current
404 means the member no longer needs onboarding, so it cannot stand in for
the retired Given. Resolve this entry as an upstream retirement when
rebuilding the remaining onboarding scenarios.

The other test changes in this range are in the API package.
