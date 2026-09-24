# Chat remote access rollout

SSH and VNC host configuration has a per-host `default_enabled_for_chats` flag. It starts `false`. A chat stores only explicit choices in `chat_thread_ssh_access_overrides` and `chat_thread_vnc_access_overrides`. For each host, effective chat access is the override's `enabled` value when a row exists; otherwise it is the host's current default. Explicit `false` is therefore distinct from no row. Deleting an override restores inheritance. Host and chat deletion cascade their override rows.

The first delivery stage adds owner APIs for defaults and overrides behind `ThreadRemoteAccess`, disabled by default. It does **not** change Runner authorization: existing Agent grants remain the runtime authority during this stage. The switch must remain off until the live thread authority and UI in #36359 are deployed and old API instances have drained. A later stage, #36360, retires Agent-wide grants after compatibility and rollback checks.

Each new API route validates the signed-in organization and user. A chat must belong to that user and reference an Agent in the current organization. SSH and VNC hosts must belong to that organization and user. VNC operations also require `VncAccess` and current VNC membership. A missing or cross-scope host or chat receives a not-found response. The host-default and chat-access responses contain names and access state, not credentials.

The chat-access API reports the selected permission for each VNC host. At runtime, an SSH-backed VNC host additionally requires access to its referenced SSH host; #36359 implements that authority check.
