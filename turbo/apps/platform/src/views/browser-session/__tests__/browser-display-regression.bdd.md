# Browser display regression

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-display-regression.test.tsx](browser-display-regression.test.tsx).

## browser-display-regression-001

Original test `A minimized remote window is restored and fitted without user action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L143).

- **Given** The remote browser's primary window is minimized and a foreign window is fullscreen.
- **When** The viewer opens.
- **Then** The primary window is restored to normal, fitted to the 900-by-600 panel, and its input is enabled without an alert. The foreign window remains fullscreen, and only the primary window receives a restore request.

## browser-display-regression-002

Original test `A maximized remote window is restored and fitted without user action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L143).

- **Given** The remote browser's primary window is maximized and a foreign window is fullscreen.
- **When** The viewer opens.
- **Then** The primary window is restored to normal, fitted to the 900-by-600 panel, and its input is enabled without an alert. The foreign window remains fullscreen, and only the primary window receives a restore request.

## browser-display-regression-003

Original test `A fullscreen remote window is restored and fitted without user action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L143).

- **Given** The remote browser's primary window is fullscreen and a foreign window is fullscreen.
- **When** The viewer opens.
- **Then** The primary window is restored to normal, fitted to the 900-by-600 panel, and its input is enabled without an alert. The foreign window remains fullscreen, and only the primary window receives a restore request.

## browser-display-regression-004

Original test `Restoring an already calibrated window waits for a fresh native frame`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L179).

- **Given** The viewer is calibrated to 900 by 600 and has received a frame. The primary window is then maximized at 1280 by 720.
- **When** The user selects “Fit window to panel” while the next native frame is held.
- **Then** The window becomes normal and the viewport stays at 1280 by 720 until a fresh frame arrives. While that frame is pending, the fit option is disabled; after release, the viewport becomes 900 by 600, input is enabled, and no alert appears.

## browser-display-regression-005

Original test `A minimized window can be synchronized again after native capture preparation fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L216).

- **Given** The primary window is maximized and automatic restoration fails while preparing native capture.
- **When** After the failure, the user minimizes the window and selects “Fit window to panel.”
- **Then** The first failure is shown as an operation error. The later explicit fit restores the window to normal, sets the viewport to 900 by 600, enables input, and clears the alert.

## browser-display-regression-006

Original test `A minimized window is restored after its pending calibration frame is invalidated`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L242).

- **Given** The viewer is calibrated at 900 by 600 and has received a frame. The primary window is maximized at 1280 by 720, and its pending calibration frame is held.
- **When** The user selects “Fit window to panel,” then a resize invalidates the held frame and the window is minimized before the pending native observation completes.
- **Then** The window is restored to normal and fitted to 900 by 600, input is enabled, and no alert appears.

## browser-display-regression-007

Original test `A target moved during restoration cannot authorize further display writes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L279).

- **Given** The viewer is calibrated at 900 by 600 with a foreign window in a separate window. The primary window is maximized and the foreign window is fullscreen.
- **When** The user starts fitting the window, then the viewed target moves into the foreign window before restoration completes.
- **Then** Input becomes disabled and the viewer reports “No tabs open.” The foreign window stays fullscreen, and no device-metrics clearing request is sent after the target moves.

## browser-display-regression-008

Original test `A rejected native restoration remains a failure after one attempt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L325).

- **Given** The primary window is maximized and the native restore request is rejected.
- **When** The viewer opens and attempts automatic restoration.
- **Then** An operation error is shown, the window remains maximized, and restoration is attempted exactly once.

## browser-display-regression-009

Original test `A ineffective native restoration remains a failure after one attempt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L325).

- **Given** The primary window is maximized and the native restore request has no effect.
- **When** The viewer opens and attempts automatic restoration.
- **Then** An operation error is shown, the window remains maximized, and restoration is attempted exactly once.

## browser-display-regression-010

Original test `An unknown native state fails without being normalized`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L349).

- **Given** The primary window reports an unknown native state.
- **When** The viewer opens.
- **Then** An operation error is shown and the unknown state is not normalized.

## browser-display-regression-011

Original test `A size-mode synchronization failure is reported rather than treated as success`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L360).

- **Given** The viewer is calibrated at 900 by 600 and the user has selected the “Off” sizing mode.
- **When** The user changes the mode to “On connection,” but native display metrics retrieval fails.
- **Then** An operation error is shown. “On connection” remains selected, and “Off” remains available rather than disabled.

## browser-display-regression-012

Original test `Automatic panel sizing exposes a native display failure without a settings action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L413).

- **Given** The viewer's initial automatic panel sizing encounters a native display resize failure, without any settings action.
- **When** The viewer opens.
- **Then** An operation error is shown, the address remains https://example.com, and browser settings remain enabled.

## browser-display-regression-013

Original test `Display synchronization resumes after image recovery with the frame first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L428).

- **Given** The viewer has recovered from a bad image; the target frame arrives before the capture-start receipt.
- **When** The primary window is maximized at 1280 by 720 and the user selects “Fit window to panel.”
- **Then** The window becomes normal, the viewport becomes 900 by 600, and input remains enabled.

## browser-display-regression-014

Original test `Display synchronization resumes after image recovery with the capture receipt first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L428).

- **Given** The viewer has recovered from a bad image; the capture-start receipt arrives before the target frame.
- **When** The primary window is maximized at 1280 by 720 and the user selects “Fit window to panel.”
- **Then** The window becomes normal, the viewport becomes 900 by 600, and input remains enabled.

## browser-display-regression-015

Original test `A window resize keeps the accepted picture while capture is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L486).

- **Given** The viewer displays an accepted live picture at 900 by 600 and input is enabled.
- **When** The panel is resized to 720 by 480 while the next target frame is held.
- **Then** Input is temporarily disabled, but the accepted live picture remains visible and no unavailable-view message or observed failure appears. After the frame arrives, the viewport is 720 by 480 and input is enabled; no window-bounds request is made.

## browser-display-regression-016

Original test `Returning to a visible viewer does not flash a failure during display setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L530).

- **Given** The viewer is visible, displaying a live picture with input enabled.
- **When** The page becomes hidden and then visible again.
- **Then** While hidden, viewing is paused and input is disabled. On return, the viewport is 900 by 600, input is enabled, the live picture is present, and no failure message flashes.
