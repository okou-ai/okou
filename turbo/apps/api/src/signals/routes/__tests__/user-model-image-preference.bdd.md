# user-model-image-preference

## user-model-image-preference-001

- Vitest: "member image preference > stores canonical Auto for nullable or explicit intent null"
- Mode: run
- Given: A signed-in member submits null as the model selection with a null service tier.
- When: The member updates and reads model preferences, then attempts to set high effort for Auto.
- Then: Update and read return HTTP 200 with canonical Auto and null service tier. Update shows empty model settings. Assigning effort to Auto returns HTTP 400.

## user-model-image-preference-002

- Vitest: "member image preference > stores canonical Auto for nullable or explicit intent auto"
- Mode: run
- Given: A signed-in member submits explicit Auto as the model selection with a null service tier.
- When: The member updates and reads model preferences, then attempts to set high effort for Auto.
- Then: Update and read return HTTP 200 with canonical Auto and null service tier. Update shows empty model settings. Assigning effort to Auto returns HTTP 400.

## user-model-image-preference-003

- Vitest: "member image preference > stores, preserves, and clears a member image default"
- Mode: run
- Given: A signed-in member can change the default image model.
- When: The member saves Flux Pro, updates model preferences while omitting the image field, then sends explicit null for the image field.
- Then: The first HTTP 200 response reports canonical Auto, Flux Pro and a non-null update time. Omission preserves Flux Pro and explicit null clears it.

## user-model-image-preference-004

- Vitest: "member image preference > pushes the image-default kind whenever the request carries the field"
- Mode: run
- Given: A signed-in member can edit preferences while realtime receives change notifications.
- When: The member updates the image default to GPT Image 2, clears it with null and finally omits the image field from a preference update.
- Then: Each update returns HTTP 200. The realtime `userPreferenceChanged` event lists both defaultModel and defaultImageModel for save and clear, and only defaultModel when omitted.
