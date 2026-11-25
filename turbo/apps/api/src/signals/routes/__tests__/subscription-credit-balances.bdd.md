# subscription-credit-balances

## subscription-credit-balances-001

- Vitest: "lists account-owned live credits"
- Mode: run
- Given: An authenticated owner has connected two Codex subscriptions with finite live balances of 1,250.5 and zero.
- When: The owner lists personal subscriptions, activates the second and lists again.
- Then: Both HTTP 200 lists preserve the account-specific balances. After activation the second account is first and active, with zero finite credits.

## subscription-credit-balances-002

- Vitest: "preserves quotas with unknown amount"
- Mode: run
- Given: The owner has two connected personal Codex subscriptions. The provider reports an unavailable numeric balance for finite credits, two reset credits and 25 percent used in a five-hour window.
- When: The owner lists personal subscriptions.
- Then: HTTP 200 reports a credit object with null balance and unlimited false for every account while preserving two reset credits and 75 percent five-hour quota remaining.

## subscription-credit-balances-003

- Vitest: "preserves quotas with unlimited credits"
- Mode: run
- Given: The owner has two connected personal Codex subscriptions. The provider reports unlimited credits without a balance, two reset credits and 25 percent used in a five-hour window.
- When: The owner lists personal subscriptions.
- Then: HTTP 200 reports a credit object with null balance and unlimited true for every account while preserving two reset credits and 75 percent five-hour quota remaining.

## subscription-credit-balances-004

- Vitest: "preserves quotas with unavailable status"
- Mode: run
- Given: The owner has two connected personal Codex subscriptions. The provider reports no credit status, two reset credits and 25 percent used in a five-hour window.
- When: The owner lists personal subscriptions.
- Then: HTTP 200 reports null subscription credits for every account while preserving two reset credits and 75 percent five-hour quota remaining.
