# Browser frames recovery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-frames-recovery.test.tsx](browser-frames-recovery.test.tsx).

## browser-frames-recovery-001

Original test `Repeated frames loss recovers only capture and waits for a fresh scoped image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L125).

- **Given** A browser viewer uses separate image and control connections and has Example and Other tabs in its primary window.
- **When** The image connection for the selected tab is lost twice, and each time the viewer waits for a fresh scoped image before continuing.
- **Then** Each loss disables remote input while recovery is pending, while the Other tab remains enabled. Fresh imagery restores input without replacing the control connection or changing the selected address. Duplicating Other creates one new tab without adding the sibling-window target or closing a target.

## browser-frames-recovery-002

Original test `Frames recovery waits for the original navigation receipt and never replays it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L175).

- **Given** A separate-image browser viewer is open with Example selected and navigation to a new address is awaiting its receipt.
- **When** The image connection is lost before the navigation receipt is released, and recovery completes afterward.
- **Then** Remote input remains disabled until the original receipt is released and recovery finishes. The navigation is sent once, and the address becomes http://next.example/.

## browser-frames-recovery-003

Original test `Frames recovery waits for the original input receipt and never replays it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L175).

- **Given** A separate-image browser viewer is open with Example selected and text input is awaiting its receipt.
- **When** The image connection is lost before the input receipt is released, and recovery completes afterward.
- **Then** Remote input remains disabled until the original receipt is released and recovery finishes. The input is sent once and is not replayed; the address remains https://example.com.

## browser-frames-recovery-004

Original test `Capture closure cannot erase a failed original input receipt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L213).

- **Given** A separate-image browser viewer is open with Example selected, and the original text input is configured to fail after its receipt is released.
- **When** The image connection is lost while the input receipt is pending, then the receipt is released and the user selects Other.
- **Then** The failed input is not erased by capture recovery or retried; the viewer remains reconnecting with input disabled and shows no Retry live image option. Selecting Other restores input and shows https://other.example; the input was sent once.

## browser-frames-recovery-005

Original test `A late capture configuration receipt cannot replace recovered imagery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L242).

- **Given** A separate-image browser viewer is open and a change to image quality 60 is awaiting its capture-configuration receipt.
- **When** The image connection is lost, recovery completes, and the delayed receipt is released.
- **Then** Remote input remains enabled and the recovered image is retained; the latest capture uses quality 60.

## browser-frames-recovery-006

Original test `A replacement image socket may fail during opening and retry without replacing control`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L261).

- **Given** A separate-image browser viewer is open with its image connection lost.
- **When** The replacement image connection fails while opening, then is allowed to open on a later recovery attempt.
- **Then** Remote input is disabled while recovery is pending, then becomes enabled after the retry. The control connection is not replaced; the viewer has only two runtime bindings.

## browser-frames-recovery-007

Original test `Closing the last tab after frames loss retains a blank without replacing control`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L283).

- **Given** A separate-image browser viewer has only the Example tab after the Other tab is closed.
- **When** The image connection is lost and the user closes the remaining Example tab during recovery.
- **Then** Recovery leaves a selected blank New tab with an empty address and enabled remote input. The control connection is not replaced, and the viewer has two runtime bindings.

## browser-frames-recovery-008

Original test `Frames loss during new-tab capture retries that tab without creating a duplicate`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L310).

- **Given** A separate-image browser viewer is open and creation of a new tab is awaiting image capture to start.
- **When** The image connection is lost during capture, the original capture receipt is released, and recovery completes.
- **Then** The new blank tab is retried rather than duplicated; the viewer has three tabs and the address is empty.

## browser-frames-recovery-009

Original test `Frames loss during an in-place image retry remains image-retryable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L326).

- **Given** A separate-image browser viewer is open with Example selected, and an image decode failure has started an in-place image retry.
- **When** The image connection is lost during that retry, the pending capture receipt is released, and recovery completes.
- **Then** Recovery restores input and keeps Example selected at https://example.com; the image remains recoverable through retry.

## browser-frames-recovery-010

Original test `A late old-frame decode failure cannot poison the replacement image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L345).

- **Given** A separate-image browser viewer is open and a frame from the current image connection is still decoding.
- **When** The image connection is lost, replacement recovery begins, and the old frame decode then fails.
- **Then** The old decode failure does not poison the replacement image. Input becomes enabled and no Retry live image option appears.

## browser-frames-recovery-011

Original test `Changing selection while the replacement socket opens never restores the retired target`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L368).

- **Given** A separate-image browser viewer is recovering from image loss, and its replacement image connection is still opening for Example.
- **When** The user selects Other before the replacement connection opens.
- **Then** Other remains selected at https://other.example after input is restored; the retired Example target is not restored, and no additional connection is created.

## browser-frames-recovery-012

Original test `Unmount closes an opening replacement socket and cannot revive the viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L391).

- **Given** A separate-image browser viewer is recovering from image loss while its replacement image connection is still opening.
- **When** The user navigates away from the viewer, then the opening connection is allowed to open.
- **Then** All active connections close, and the viewer does not reappear.

## browser-frames-recovery-013

Original test `A true control failure after image loss still revokes the whole viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L415).

- **Given** A separate-image browser viewer has already lost its image connection and is recovering.
- **When** The control connection then fails.
- **Then** The viewer remains reconnecting with remote input and New tab disabled; the whole viewer is revoked.

## browser-frames-recovery-014

Original test `A true extension failure after image loss still revokes the whole viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L415).

- **Given** A separate-image browser viewer has already lost its image connection and is recovering.
- **When** The browser extension then fails.
- **Then** The viewer remains reconnecting with remote input and New tab disabled; the whole viewer is revoked.

## browser-frames-recovery-015

Original test `A true window failure after image loss still revokes the whole viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L415).

- **Given** A separate-image browser viewer has already lost its image connection and is recovering.
- **When** The primary browser window is removed.
- **Then** The viewer remains reconnecting with remote input and New tab disabled; the whole viewer is revoked.

## browser-frames-recovery-016

Original test `A target moved to a sibling window during image loss is not recovered into the viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.test.tsx#L438).

- **Given** A separate-image browser viewer is recovering from image loss with Example selected and Other still open in the primary window.
- **When** The Example target moves to a sibling window before recovery completes.
- **Then** Input becomes enabled, but Example is not restored into the viewer; Other remains selected at https://other.example.
