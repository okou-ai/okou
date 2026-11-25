# remote-runtime-invalidation

## remote-runtime-invalidation-001

- Vitest: "protocol-specific remote runtime invalidation > isolates VNC defaults and chat overrides by owner and thread while SSH and Runs remain authorized"
- Mode: run
- Given: An owner has active Runs in two threads, plus a same-workspace Run owned by someone else and a Run owned by the original owner in another workspace. The owner has registered separate VNC and SSH connections and enabled SSH by default.
- When: The owner enables the VNC default, disables it in the first thread, clears that override, and disables the default. Assigned Runners resolve both protocols between changes, and authorized members read the Runs.
- Then: VNC resolves for both, then only the second, then both, then neither. Realtime publishes the owner organization change and VNC invalidations to the affected Runner group for both Runs on default edits and only the first Run on override edits, without SSH invalidations. SSH continues resolving for both owner Runs and all four Runs remain running.
