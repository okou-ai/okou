# org-invitation-purchase

## org-invitation-purchase-001

- Vitest: "publishes a paid 20 USD invitation and preserves it on replay"
- Mode: run
- Given: An authenticated organization administrator has configured paid usage-pack billing and wants to invite a member with a 20 USD pack. Stripe can pay the invoice and Clerk can create the invitation.
- When: The administrator previews and confirms the purchase, reads pending invitations, and replays confirmation while new provider creation would fail.
- Then: The preview returns HTTP 200 with a 2000 cent immediate USD charge and the requested pack. Confirmation and replay both return HTTP 200 with `Invitation purchased and sent`. Both member-list reads show the same single pending invitation, including its member role, timestamp and 20 USD pack. The organization’s usage-pack credit view stays identical.

## org-invitation-purchase-002

- Vitest: "publishes a paid 50 USD invitation and preserves it on replay"
- Mode: run
- Given: An authenticated organization administrator has configured paid usage-pack billing and wants to invite a member with a 50 USD pack. Stripe can pay the invoice and Clerk can create the invitation.
- When: The administrator previews and confirms the purchase, reads pending invitations, and replays confirmation while new provider creation would fail.
- Then: The preview returns HTTP 200 with a 5000 cent immediate USD charge and the requested pack. Confirmation and replay both return HTTP 200 with `Invitation purchased and sent`. Both member-list reads show the same single pending invitation, including its member role, timestamp and 50 USD pack. The organization’s usage-pack credit view stays identical.
