# discord-lifecycle

## discord-lifecycle-001

- Vitest: "removes a departed member's binding only in the affected organization"
- Mode: run
- Given: A user has Discord bindings in two organizations, and a peer retains a separate binding in the first organization's shared installation. The departing user's binding in the first organization is selected for DMs.
- When: Clerk submits a verified `organizationMembership.deleted` event to `POST /api/webhooks/clerk` for the user's membership in the first organization. The surviving peer and the same user in their other organization read `GET /api/integrations/discord`.
- Then: The webhook and both reads return HTTP 200. The peer remains connected under their own Discord user ID. The other organization still reports the user connected and exposes only that organization's binding, with no selected DM connection.

## discord-lifecycle-002

- Vitest: "user deletion retains the shared installation and a surviving peer's binding"
- Mode: run
- Given: A user installed the Discord bot for a workspace, and a surviving workspace peer connected separately to the same bot and guild.
- When: Clerk submits a verified `user.deleted` event to `POST /api/webhooks/clerk` for the installer, then the surviving peer reads `GET /api/integrations/discord`.
- Then: The webhook and read return HTTP 200. The peer remains connected to the same guild under their own Discord user ID, and their connection is the only DM binding in the response.
