# chat-remote-access

## chat-remote-access-001

- Vitest: "chat remote access owner API > inherits the current default without chat rows and preserves explicit allow or deny across multiple hosts"
- Mode: run
- Given: A signed-in member has two threads and two SSH hosts "First host" and "Second host" created with `POST /api/ssh/connections`, and no VNC connections.
- When: The member reads `GET /api/chat-threads/:threadId/remote-access`, enables the first host default with `PUT /api/remote-access/hosts/ssh/:connectionId/default`, overrides the first host off and the second on for the first thread with `PUT /api/chat-threads/:threadId/remote-access/ssh/:connectionId`, clears the first override with `DELETE`, disables the first default, deletes the second host with `DELETE /api/ssh/connections/:connectionId`, and recreates a host with the second host's ID.
- Then: Initially both SSH hosts are disabled with `source: "default"`, no override, and VNC is empty. After overrides, the first thread shows `[false, override]` and `[true, override]` while the second thread inherits `[true, default]` and `[false, default]`. Clearing returns `enabled: true`, `overrideEnabled: null`, `source: "default"`; after the default flip the first host is disabled by default and the second stays enabled by override. After deletion (HTTP 204) only the first host is listed, and the recreated host appears disabled by default with no override.

## chat-remote-access-002

- Vitest: "chat remote access owner API > makes owner host defaults available and gives cross-owner IDs the same not-found result"
- Mode: run
- Given: A first owner has a thread and an SSH host "Private host" and can list `GET /api/remote-access/hosts`. A second owner has a thread, and the second owner's user ID also has a thread and SSH host in another organization.
- When: The second owner reads the first owner's thread access, enables the first owner's host default, overrides the first owner's host on their own thread, reads the other-organization thread access, and enables the other-organization host default.
- Then: The first owner's host list returns HTTP 200. Every cross-owner and cross-organization request returns HTTP 404, and the other-organization thread error body is identical to the cross-owner thread error body.

## chat-remote-access-003

- Vitest: "chat remote access owner API > exposes VNC defaults and thread overrides"
- Mode: run
- Given: A signed-in member has a thread and a VNC connection "VNC desktop" created through the VNC connections API.
- When: The member lists `GET /api/remote-access/hosts`, enables a VNC thread override, enables the VNC host default, disables the thread override, and clears it with `DELETE /api/chat-threads/:threadId/remote-access/vnc/:connectionId`.
- Then: Host defaults list the VNC connection with `defaultEnabled: false`. With the enabling override the thread entry is `enabled: true`, `source: "override"`. With the default on and override off it is `defaultEnabled: true`, `overrideEnabled: false`, `enabled: false`, `source: "override"`. Clearing returns `defaultEnabled: true`, `overrideEnabled: null`, `enabled: true`, `source: "default"`.

## chat-remote-access-004

- Vitest: "chat remote access owner API > rejects foreign ssh configuration changes sharing the orgId and preserves both owners' choices"
- Mode: run
- Given: An owner has a thread and an SSH host with an enabled thread override; a peer in the same organization (row `ssh`, shared `orgId`) has their own thread and SSH host with an enabled override.
- When: The peer reads host defaults and thread access and then tries to change the owner's host default, override and clear the owner's host on the peer thread, read the owner thread, override the peer host on the owner thread, and clear the owner override; the owner then reads, clears the override and enables the host default.
- Then: As the peer, host defaults and thread access list only the peer host. The peer gets HTTP 404 for changing the owner host default (same body as an unknown host), overriding or clearing the owner host on the peer thread (clear body identical to an unknown host), reading the owner thread (same body as an unknown thread), overriding the peer host on the owner thread, and clearing the owner override; the peer defaults and thread access are unchanged. Back as the owner, defaults and thread access are unchanged; clearing the override returns HTTP 200 with the original entry but `overrideEnabled: null`, `enabled: false`, `source: "default"`, and enabling the owner default makes the thread entry `defaultEnabled: true`, `enabled: true`.

## chat-remote-access-005

- Vitest: "chat remote access owner API > rejects foreign ssh configuration changes sharing the userId and preserves both owners' choices"
- Mode: run
- Given: An owner has a thread and an SSH host with an enabled thread override; the same user ID in another organization (row `ssh`, shared `userId`) acts as a peer with their own thread and SSH host with an enabled override.
- When: The peer reads host defaults and thread access and then tries to change the owner's host default, override and clear the owner's host on the peer thread, read the owner thread, override the peer host on the owner thread, and clear the owner override; the owner then reads, clears the override and enables the host default.
- Then: As the peer, host defaults and thread access list only the peer host. The peer gets HTTP 404 for changing the owner host default (same body as an unknown host), overriding or clearing the owner host on the peer thread (clear body identical to an unknown host), reading the owner thread (same body as an unknown thread), overriding the peer host on the owner thread, and clearing the owner override; the peer defaults and thread access are unchanged. Back as the owner, defaults and thread access are unchanged; clearing the override returns HTTP 200 with the original entry but `overrideEnabled: null`, `enabled: false`, `source: "default"`, and enabling the owner default makes the thread entry `defaultEnabled: true`, `enabled: true`.

## chat-remote-access-006

- Vitest: "chat remote access owner API > rejects foreign vnc configuration changes sharing the orgId and preserves both owners' choices"
- Mode: run
- Given: An owner has a thread and a VNC connection with an enabled thread override; a peer in the same organization (row `vnc`, shared `orgId`) has their own thread and VNC connection with an enabled override.
- When: The peer reads host defaults and thread access and then tries to change the owner's VNC default, override and clear the owner's VNC connection on the peer thread, read the owner thread, override the peer connection on the owner thread, and clear the owner override; the owner then reads, clears the override and enables the default.
- Then: As the peer, host defaults and thread access list only the peer host. The peer gets HTTP 404 for changing the owner host default (same body as an unknown host), overriding or clearing the owner host on the peer thread (clear body identical to an unknown host), reading the owner thread (same body as an unknown thread), overriding the peer host on the owner thread, and clearing the owner override; the peer defaults and thread access are unchanged. Back as the owner, defaults and thread access are unchanged; clearing the override returns HTTP 200 with the original entry but `overrideEnabled: null`, `enabled: false`, `source: "default"`, and enabling the owner default makes the thread entry `defaultEnabled: true`, `enabled: true`.

## chat-remote-access-007

- Vitest: "chat remote access owner API > rejects foreign vnc configuration changes sharing the userId and preserves both owners' choices"
- Mode: run
- Given: An owner has a thread and a VNC connection with an enabled thread override; the same user ID in another organization (row `vnc`, shared `userId`) acts as a peer with their own thread and VNC connection with an enabled override.
- When: The peer reads host defaults and thread access and then tries to change the owner's VNC default, override and clear the owner's VNC connection on the peer thread, read the owner thread, override the peer connection on the owner thread, and clear the owner override; the owner then reads, clears the override and enables the default.
- Then: As the peer, host defaults and thread access list only the peer host. The peer gets HTTP 404 for changing the owner host default (same body as an unknown host), overriding or clearing the owner host on the peer thread (clear body identical to an unknown host), reading the owner thread (same body as an unknown thread), overriding the peer host on the owner thread, and clearing the owner override; the peer defaults and thread access are unchanged. Back as the owner, defaults and thread access are unchanged; clearing the override returns HTTP 200 with the original entry but `overrideEnabled: null`, `enabled: false`, `source: "default"`, and enabling the owner default makes the thread entry `defaultEnabled: true`, `enabled: true`.
