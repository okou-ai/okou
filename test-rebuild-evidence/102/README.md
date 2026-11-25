# Batch 102 frozen-case review

The starting [register at 7472832fce](https://github.com/okou-ai/okou/blob/7472832fcea6f05c1bf7b26f11e15a0ba4b88dc0/turbo/apps/platform/test-rebuild-pending.bdd.md) had 146 cases. Two original scenarios passed in full and one closed after an upstream change to its entry point. This leaves 143 cases across 47 owners. All six pending product decisions remain in that count. The [68 upstream scenarios](../../turbo/apps/platform/test-rebuild-upstream-pending.bdd.md) are tracked separately. The [case ledger](../../turbo/apps/platform/test-rebuild-batch-102.tsv) preserves the original Given/When/Then for all four cases reviewed.

## discord-oauth-compatibility-007

In two fresh Chromium contexts, a native opener opened the production Discord callback page with a proof issued by the isolated API’s OAuth start and provider callback. The Discord provider and Clerk identity were test boundaries. The App submitted the proof through the authenticated approval route backed by local PostgreSQL. The receiver held the HTTP response after the server accepted the approval. The opener was still alive at that point. Closing it interrupted the callback before the response was released.

| Observation | Page alone | Relay repeats the same payload |
| --- | --- | --- |
| API receipts for this OAuth state | 200 | 200, then 400 with `DISCORD_OAUTH_INVALID_ATTEMPT` |
| Response delivered to the page | 200 | 200 |
| Page after delivery | This authorization was interrupted or refreshed. | Same message |
| Open Discord links | 0 | 0 |
| URL after delivery | No fragment or proof | No fragment or proof |

Receipts are grouped by a digest of the OAuth state. Only the relay sent the extra POST in the second arm. The API can distinguish a rejected replay. The member-facing result and single accepted approval are identical in both arms. The exact submission count remains open under the [original ID](../../turbo/apps/platform/test-rebuild-pending.bdd.md#discord-oauth-compatibility-007). [Browser and receiver receipts](./discord.json)

## agent-suggestions-007

The obsolete Agents destination has an upstream disposition. The legacy route redirects into personal settings, and workspace Workflows is a retained destination. The rewritten journey leaves For you for Workflows, changes the active workspace through the membership menu and reopens For you. [Single-agent rollout](https://github.com/okou-ai/okou/pull/49556) · [Legacy route](https://github.com/okou-ai/okou/blob/c83928ad6fc787a648fa6f2a71fbf5d98b3001cc/turbo/apps/platform/src/signals/agents-page/agents-page-setup.ts)

The routed control published one suggestion per workspace via each workspace’s authorized run. The same member used the Clerk fixture’s two workspace credentials. Each feed read reached the local product API using the credential supplied by the App. Acme displayed “Reserve the Acme lab” alone. Design displayed “Review the design proofs” alone after the switch. The returned card IDs match the creation receipts. This closes the revised case. [Workspace receipts](./suggestions.json)

## agent-suggestions-012

The suggested action opened the existing chat with an active run. Its composer showed the dispatch text and chat reference. The member clicked Send. The real chat endpoint accepted that event with HTTP 201. After background work drained, an authenticated event-history read found the same client event ID with the original text and reference in the target chat. The existing run was present and the new input had no claiming run. This is the first complete acceptance of the original queue scenario. [Page and event receipts](./suggestions.json)

## agent-suggestions-013

After the member loaded the new-chat action, the provider used the suggestion update route to change the selected option to an existing chat and “Divert the shipment to Oslo”. The App’s consume request returned the later option. The test awaited the decoded reply, the sent confirmation and the For you route. An authenticated history read located the original dispatch text and reference under the newly created chat and found the event absent from the later target. This is the first complete acceptance of the original scenario. [Page and event receipts](./suggestions.json)

## Review boundaries

The three ordinary regressions are registered in the [owning App suite](../../turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx). The independent controls use production App routes and API handlers, the repository’s external identity and provider fixtures, and freshly migrated local PostgreSQL. Message and card IDs in the receipts are test records. The original registrations and their fixture behavior were reviewed against the new journeys after drafting. The historical route change applies only to agent-suggestions-007.
