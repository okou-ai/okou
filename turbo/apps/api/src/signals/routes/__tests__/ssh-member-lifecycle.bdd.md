# ssh-member-lifecycle

## ssh-member-lifecycle-001

- Vitest: "self-leave erases the departing member's private remote resources after VNC dependencies"
- Mode: run
- Given: A departing organization member owns two SSH logins (one unused), a personal Cloudflare Access gateway, a personal Tailscale network, two SSH hosts (one behind the personal gateway), a VNC desktop that tunnels both its RFB and Kerberos KDC traffic through those hosts, and two more hosts using organization-shared Access and Tailscale configs. A surviving peer owns a login and two hosts on the shared configs, and the departing user also has a host and login in another organization.
- When: The departing member leaves with `POST /api/org/leave`. The peer then recreates a login and host reusing the departed unused login ID and RFB host ID, the Clerk `organizationMembership.deleted` webhook is delivered twice to `POST /api/webhooks/clerk`, and the departing user rejoins the organization and reads and edits their former resources.
- Then: Leaving returns `Left org`. After rejoining, the user's SSH hosts, SSH credentials, VNC desktops and VNC credentials lists are empty; updating each former host, login and the desktop returns HTTP 404; the former personal Access gateway and Tailscale network are absent from the lists, and recreating them with the same IDs returns HTTP 201 with no SSH hosts attached. The peer still sees exactly their two hosts plus the reclaimed host, their two logins with the matching hosts, and the shared Access and Tailscale configs each linked only to the peer's host. The departing user's other-organization host and login are unchanged.

## ssh-member-lifecycle-002

- Vitest: "administrator erases the departing member's private remote resources after VNC dependencies"
- Mode: run
- Given: A departing organization member owns two SSH logins (one unused), a personal Cloudflare Access gateway, a personal Tailscale network, two SSH hosts (one behind the personal gateway), a VNC desktop that tunnels both its RFB and Kerberos KDC traffic through those hosts, and two more hosts using organization-shared Access and Tailscale configs. A surviving peer administrator owns a login and two hosts on the shared configs, and the departing user also has a host and login in another organization.
- When: The peer removes the departing member by email with `DELETE /api/org/members`. The peer then recreates a login and host reusing the departed unused login ID and RFB host ID, the Clerk `organizationMembership.deleted` webhook is delivered twice to `POST /api/webhooks/clerk`, and the departing user rejoins the organization and reads and edits their former resources.
- Then: Removal returns `Removed <email> from org`. After rejoining, the user's SSH hosts, SSH credentials, VNC desktops and VNC credentials lists are empty; updating each former host, login and the desktop returns HTTP 404; the former personal Access gateway and Tailscale network are absent from the lists, and recreating them with the same IDs returns HTTP 201 with no SSH hosts attached. The peer still sees exactly their two hosts plus the reclaimed host, their two logins with the matching hosts, and the shared Access and Tailscale configs each linked only to the peer's host. The departing user's other-organization host and login are unchanged.

## ssh-member-lifecycle-003

- Vitest: "Clerk webhook erases the departing member's private remote resources after VNC dependencies"
- Mode: run
- Given: A departing organization member owns two SSH logins (one unused), a personal Cloudflare Access gateway, a personal Tailscale network, two SSH hosts (one behind the personal gateway), a VNC desktop that tunnels both its RFB and Kerberos KDC traffic through those hosts, and two more hosts using organization-shared Access and Tailscale configs. A surviving peer owns a login and two hosts on the shared configs, and the departing user also has a host and login in another organization. The membership has already been removed in Clerk.
- When: A signed Clerk `organizationMembership.deleted` webhook is delivered to `POST /api/webhooks/clerk`. The peer then recreates a login and host reusing the departed unused login ID and RFB host ID, the webhook is delivered twice more, and the departing user rejoins the organization and reads and edits their former resources.
- Then: Each webhook delivery returns HTTP 200. After rejoining, the user's SSH hosts, SSH credentials, VNC desktops and VNC credentials lists are empty; updating each former host, login and the desktop returns HTTP 404; the former personal Access gateway and Tailscale network are absent from the lists, and recreating them with the same IDs returns HTTP 201 with no SSH hosts attached. The peer still sees exactly their two hosts plus the reclaimed host, their two logins with the matching hosts, and the shared Access and Tailscale configs each linked only to the peer's host. The departing user's other-organization host and login are unchanged.

## ssh-member-lifecycle-004

- Vitest: "membership deletion and replay safely erase an owner with unused credentials"
- Mode: run
- Given: An organization member owns one SSH login that is not attached to any host, and their membership has been removed in Clerk.
- When: A signed Clerk `organizationMembership.deleted` webhook is delivered twice to `POST /api/webhooks/clerk`, and the user then rejoins the organization and lists SSH hosts and credentials.
- Then: Both deliveries return HTTP 200, and after rejoining the user's SSH host and SSH credential lists are empty.

## ssh-member-lifecycle-005

- Vitest: "membership deletion and replay safely erase an owner with empty"
- Mode: run
- Given: An organization member owns no SSH resources, and their membership has been removed in Clerk.
- When: A signed Clerk `organizationMembership.deleted` webhook is delivered twice to `POST /api/webhooks/clerk`, and the user then rejoins the organization and lists SSH hosts and credentials.
- Then: Both deliveries return HTTP 200, and after rejoining the user's SSH host and SSH credential lists are empty.
