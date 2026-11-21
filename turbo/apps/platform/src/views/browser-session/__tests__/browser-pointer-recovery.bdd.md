# Browser pointer recovery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-pointer-recovery.test.tsx](browser-pointer-recovery.test.tsx).

Batch 37 accepted 002, 005 and 007. Selected ID 008 remains pending.

## browser-pointer-recovery-001

Original test `An unacknowledged hover recovers after its session ends (target destroyed: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-pointer-recovery.test.tsx#L127).

- **Given** An ordinary unmodified hover has been sent to the selected tab and is awaiting a reply.
- **When** The tab's original viewing session ends, but the tab remains open.
- **Then** The same tab becomes usable again for text input and navigation. The original hover is not replayed when its late reply arrives.

## browser-pointer-recovery-002

Original test `An unacknowledged hover recovers after its session ends (target destroyed: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-pointer-recovery.test.tsx#L127).

- **Given** An ordinary unmodified hover has been sent to the selected tab and is awaiting a reply.
- **When** The remote browser removes that tab.
- **Then** The sibling tab is selected and accepts text and navigation. The original hover is not replayed when its late reply arrives.

## browser-pointer-recovery-003

Original test `An unacknowledged mouse press retains its original failure and same-tab fence`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-pointer-recovery.test.tsx#L198).

- **Given** The selected tab is live.
- **When** The user presses the mouse and the session ends before the press is acknowledged.
- **Then** The original input failure is reported and the tab stays unavailable even after a late reply. A healthy sibling remains usable.

## browser-pointer-recovery-004

Original test `An unacknowledged mouse release retains its original failure and same-tab fence`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-pointer-recovery.test.tsx#L198).

- **Given** A mouse press has already reached the selected tab.
- **When** The user releases the mouse and the session ends before the release is acknowledged.
- **Then** The original release failure is reported and the tab stays unavailable even after a late reply. A healthy sibling remains usable.

## browser-pointer-recovery-005

Original test `An unacknowledged mouse drag retains its original failure and same-tab fence`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-pointer-recovery.test.tsx#L198).

- **Given** A mouse press has already reached the selected tab.
- **When** The user drags and the session ends before the movement is acknowledged.
- **Then** The original drag failure is reported and the tab stays unavailable even after a late reply. A healthy sibling remains usable.

## browser-pointer-recovery-006

Original test `An unacknowledged mouse modified hover retains its original failure and same-tab fence`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-pointer-recovery.test.tsx#L198).

- **Given** The selected tab is live.
- **When** The user hovers while holding a modifier, and the session ends before the movement is acknowledged.
- **Then** The original modified-hover failure is reported and the tab stays unavailable even after a late reply. A healthy sibling remains usable.

## browser-pointer-recovery-007

Original test `A detached neutral hover cannot hide a held key's failed original release`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-pointer-recovery.test.tsx#L257).

- **Given** The user is holding a key in the selected browser tab and an ordinary hover is awaiting a reply.
- **When** The tab's session ends before the hover completes.
- **Then** The view becomes unavailable with input disabled, and diagnostics retain the original failed key release.

## browser-pointer-recovery-008

Original test `A detached neutral hover preserves an earlier native rejection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-pointer-recovery.test.tsx#L294).

- **Given** A previous hover was rejected by the native browser.
- **When** The selected tab's session ends while a later ordinary hover is pending.
- **Then** The selected tab stays unavailable and diagnostics preserve the earlier rejection. A healthy sibling can still be used.
