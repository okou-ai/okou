# Tailscale parity

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [tailscale-parity.test.tsx](tailscale-parity.test.tsx).

## tailscale-parity-001

Original test `A common SSH notice refreshes network usage and restores deletion after unbinding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-parity.test.tsx#L69).

- **Given** A Tailscale network is not used by any of the user’s hosts, so deletion is enabled.
- **When** An SSH-change notice arrives for the organization while a private server is bound, then another notice arrives after it is unbound.
- **Then** The network usage refreshes to show the server and disables deletion; after unbinding, it shows no hosts using the network and enables deletion again.

## tailscale-parity-002

Original test `Saving unchanged normalized metadata returns to details even when writes are unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-parity.test.tsx#L99).

- **Given** The user edits a network whose displayed name has surrounding spaces entered in the form, and its allowed tags are entered in the same normalized order as the saved values. Network writes return an error.
- **When** The user saves the unchanged normalized metadata.
- **Then** The app returns to the network details, where the edit action is available; the failed write does not prevent this return.

## tailscale-parity-003

Original test `An intentional tag-order edit is saved against the current revision`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-parity.test.tsx#L114).

- **Given** The user edits a network at revision 1 with tags “tag:okou” and “tag:build.”
- **When** The user reverses the tag order and saves.
- **Then** The details show “tag:build, tag:okou,” and the save is made against revision 1 with the new tag order.

## tailscale-parity-004

Original test `Affected members expose identifiers only for ambiguous or unavailable names`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-parity.test.tsx#L136).

- **Given** A shared network’s impact preview lists one uniquely named member, two members with the same display name, and one member whose name is unavailable.
- **When** The user opens the delete confirmation.
- **Then** The unique name appears without an identifier. Both ambiguous names include their full IDs, while the unavailable name is shown as “Name unavailable” with only the ID suffix “87654321.”

## tailscale-parity-005

Original test `A zero-impact delete needs no other-owner acknowledgement`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-parity.test.tsx#L165).

- **Given** A shared Tailscale network’s deletion preview reports zero other hosts and no affected owners.
- **When** The user opens the delete confirmation and confirms deletion without acknowledging other owners.
- **Then** No acknowledgement checkbox is required; deletion completes and the private-networks directory shows no networks added.

## tailscale-parity-006

Original test `A zero-impact restrict needs no other-owner acknowledgement`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-parity.test.tsx#L165).

- **Given** A shared Tailscale network’s restriction preview reports zero other hosts and no affected owners.
- **When** The user changes its scope to “Only me,” saves, and confirms without acknowledging other owners.
- **Then** No acknowledgement checkbox is required; the network becomes personal and its details show “Only me.”
