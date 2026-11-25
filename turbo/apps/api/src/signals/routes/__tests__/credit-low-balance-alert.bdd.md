# credit-low-balance-alert

## credit-low-balance-alert-001

- Vitest: "low-credit membership cache public authority > preserves the first admin across membership pages after a five-credit shared debit"
- Mode: run
- Given: A Pro organization starts with 5,005 credits and disabled auto-recharge. The administrator has a previously authorized CLI token and the ordinary member has a CLI token that previously got 403 when changing recharge settings. The directory’s first page grants admin to the member and its second page repeats the same identity as a member.
- When: A five-credit shared debit triggers a low-credit membership refresh. With live membership lookup then unavailable, the promoted user attempts to update auto-recharge.
- Then: A session read shows 5,000 credits and the promoted user’s CLI request returns HTTP 200.

## credit-low-balance-alert-002

- Vitest: "low-credit membership cache public authority > revokes an omitted cached admin after a five-credit shared debit"
- Mode: run
- Given: A Pro organization starts with 5,005 credits and disabled auto-recharge. The administrator has a previously authorized CLI token and the ordinary member has a CLI token that previously got 403 when changing recharge settings. The paginated directory no longer contains the original administrator.
- When: A five-credit shared debit triggers membership refresh and the omitted administrator attempts to update auto-recharge with live lookup unavailable.
- Then: The balance is 5,000. The omitted administrator receives HTTP 503 with `Cache-Control: no-store`.

## credit-low-balance-alert-003

- Vitest: "low-credit membership cache public authority > removes both cached roles when the low-credit refresh receives no memberships"
- Mode: run
- Given: A Pro organization starts with 5,005 credits and disabled auto-recharge. The administrator has a previously authorized CLI token and the ordinary member has a CLI token that previously got 403 when changing recharge settings. The directory returns no memberships during refresh.
- When: After a five-credit shared debit, both CLI callers attempt to update auto-recharge with live lookup unavailable.
- Then: The balance is 5,000. Both callers receive HTTP 503 with `Cache-Control: no-store`.
