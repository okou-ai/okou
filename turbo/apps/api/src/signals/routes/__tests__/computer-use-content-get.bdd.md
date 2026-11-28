# computer-use-content-get

## computer-use-content-get-001

- Vitest: "Computer Use screenshot download URLs > returns private screenshot metadata with owner and host authorization"
- Mode: run
- Given: An organization member owns a host that completed a claimed Safari state command with a stored PNG screenshot. The owner can also use an organization-admin PAT and a Run token bound to that host.
- When: The owner, the PAT, the bound Run, an anonymous caller, a user without an organization, another member, a member of a different organization and Runs with a different or no host binding request screenshot download metadata.
- Then: The owner, PAT and bound Run receive identical metadata with a download URL for the command screenshot, filename `screenshot.png`, PNG content type, exact byte size and `private, no-store`. Anonymous and organization-less callers get HTTP 401. The other members and wrong-host Run get HTTP 404 with `NOT_FOUND` and `Computer-use command screenshot not found`. The unbound Run gets HTTP 403.
