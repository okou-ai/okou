# Retired Morning Brief thread provenance

The Native Morning Brief Chat collector was removed in
[#36750](https://github.com/okou-ai/okou/pull/36750) on September 25, 2026.
It was the only production consumer of `chat_threads.provenance`.
The September 26 advisory-lock cleanup stops classifying ordinary Chat and
Official Workflow destinations, and removes the unused classification service
and its implementation-only tests.

The nullable column and historical migrations remain. Current APIs do not use
it to grant access, select messages, or schedule work. Column contraction is a
separate schema cleanup; an older API may still write it during rollout.

Automation destinations continue to use the unique organization/user/workflow
binding. Creation and thread deletion coordinate through that binding row;
reusing a destination no longer updates its thread. API coverage verifies
concurrent creation, destination reuse, and deletion followed by rebinding.

See [deployment compatibility](deployment-compatibility.md) for the outgoing
resolver boundary and [Morning Brief native scheduling](morning-brief-native-scheduling.md)
for the retired collector's independent historical state.
