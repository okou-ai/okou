# run-lifecycle-billing.bdd

## run-lifecycle-billing.bdd-001

- Vitest: "BILL: public usage member access > keeps member totals consistent with image-provider breakdowns"
- Mode: run
- Given: An administrator and member share a funded workspace with a billing period beginning at 09:15 UTC. On assigned Runs, both submit the same GPT Image output and input usage plus one Nano Banana output. Both Runs fail and settle.
- When: The administrator requests 24-hour member usage in Asia/Shanghai, reads the current billing-period report and reads their own usage record.
- Then: Both members appear ordered by user ID with directory emails, 108 credits each and all model token totals zero. Each exact image breakdown attributes 80 credits to Nano Banana and 28 to GPT Image. The billing-period report starts at 09:15 UTC and matches the members, and the administrator’s own record matches the total and breakdown. Repeating the member report preserves the rows.

## run-lifecycle-billing.bdd-002

- Vitest: "BILL: public usage member access > validates member usage access and returns an empty public report"
- Mode: run
- Given: An entitled workspace has no recorded member usage. The workspace has an administrator and a non-admin member.
- When: Both request the workspace member usage report.
- Then: The member receives HTTP 403 with `FORBIDDEN`. The administrator receives a report with a non-null period and no members.
