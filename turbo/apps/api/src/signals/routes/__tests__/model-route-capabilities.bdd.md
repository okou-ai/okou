# model-route-capabilities

## model-route-capabilities-001

- Vitest: "personal model route capabilities > rejects max and accepts xhigh for the connected Luna subscription"
- Mode: run
- Given: An onboarded limited-free organization member has connected the subscription that exposes Luna.
- When: The member updates model preferences for Luna with max effort and then xhigh.
- Then: Max returns HTTP 400. Xhigh returns HTTP 200 with Luna as the only model settings key and xhigh as its effort.

## model-route-capabilities-002

- Vitest: "personal model route capabilities > offers Fast only for a connected model whose route supports priority"
- Mode: run
- Given: An onboarded member has connected subscription routes for Claude Fable and GPT-6 Astra.
- When: The member requests Fast priority for each model in their model preferences.
- Then: Fable returns HTTP 400. Astra returns HTTP 200 and the saved service tier is priority.
