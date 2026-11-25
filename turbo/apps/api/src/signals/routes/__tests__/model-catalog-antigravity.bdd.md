# model-catalog-antigravity

## model-catalog-antigravity-001

- Vitest: "staff Antigravity model catalog > shows the three models and their effort options only to the opted-in member"
- Mode: run
- Given: An authenticated staff workspace member has not opted in to the Antigravity pilot.
- When: The member reads the catalog before and after opt-in. A peer in the same workspace and the same identity outside staff also read the catalog.
- Then: Before opt-in and for both other identities the pilot models are hidden. Opt-in publishes `runModelsChanged` with null payload to the staff member’s channel. The pilot exposes Neon, Carbon and Hydrogen with disabled Antigravity routes, matching upstream model IDs, medium default effort, no service tiers and no Pi support. Each supports low, medium and high, with xhigh also available for Neon and Hydrogen.

## model-catalog-antigravity-002

- Vitest: "staff Antigravity model catalog > keeps an unbound Google selection out of runnable models and rejects a direct thread request"
- Mode: run
- Given: A staff workspace member has no bound Google AI account. The pilot is initially disabled and then enabled.
- When: The member requests a Neon thread before opt-in, then reads runnable models and requests each pilot model after opt-in.
- Then: Before opt-in the thread request returns HTTP 400 asking for Auto or a connected personal subscription. After opt-in the runnable list is only Auto and all three direct thread requests return HTTP 400 requiring a connected personal Google AI subscription.
