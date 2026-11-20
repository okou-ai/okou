# Browser touch regression

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-touch-regression.test.tsx](browser-touch-regression.test.tsx).

## browser-touch-regression-01

Original test `A touch tap with small finger jitter clicks once despite compatibility mouse events`.

Registered test `A touch tap with small finger jitter clicks once despite compatibility mouse events`.

- **Given** The viewer is usable on a touch device.
- **When** The user taps with slight finger movement and the platform also emits compatibility mouse events.
- **Then** The remote page receives one click at the release position and remote input gets focus.

## browser-touch-regression-02

Original test `A swipe routes finger-opposed scrolling to its starting region without a click or keyboard focus`.

Registered test `A swipe routes finger-opposed scrolling to its starting region without a click or keyboard focus`.

- **Given** The viewer is usable on a touch device.
- **When** The user swipes across the live image.
- **Then** The remote page scrolls opposite the finger motion at the starting region without a click or keyboard focus.

## browser-touch-regression-03

Original test `%s cancels a pending gesture and a fresh tap remains usable`.

- **Given** A touch gesture is underway.
- **When** The gesture is interrupted and the user makes a fresh tap.
- **Then** Only the fresh tap reaches the remote page.

Examples

- `browser-touch-regression-03.01` Pointer cancellation
  Registered test `pointercancel cancels a pending gesture and a fresh tap remains usable`.
- `browser-touch-regression-03.02` Loss of pointer capture
  Registered test `lostpointercapture cancels a pending gesture and a fresh tap remains usable`.
- `browser-touch-regression-03.03` A second finger joins
  Registered test `second-finger cancels a pending gesture and a fresh tap remains usable`.

## browser-touch-regression-04

Original test `Touch starting in letterbox space is ignored while the mapped image remains clickable`.

Registered test `Touch starting in letterbox space is ignored while the mapped image remains clickable`.

- **Given** The live picture has letterbox margins.
- **When** The user taps the margin and then the picture.
- **Then** Only the tap on the picture reaches the page, at the mapped remote coordinates.

## browser-touch-regression-05

Original test `A touch from the old tab cannot click the newly selected tab`.

Registered test `A touch from the old tab cannot click the newly selected tab`.

- **Given** A touch has started on one tab.
- **When** The user selects a different tab, finishes the old touch, and taps again.
- **Then** Only the new tap reaches the newly selected tab.

## browser-touch-regression-06

Original test `A document change discards a pending swipe before another touch is admitted`.

Registered test `A document change discards a pending swipe before another touch is admitted`.

- **Given** A swipe is underway.
- **When** The document navigates within the page before the swipe completes, then the user makes a new tap.
- **Then** The original swipe is discarded and the new tap reaches the page.

## browser-touch-regression-07

Original test `Desktop mouse click and wheel input keep their existing behavior`.

Registered test `Desktop mouse click and wheel input keep their existing behavior`.

- **Given** The viewer is open on desktop.
- **When** The user clicks and scrolls with a mouse.
- **Then** The remote page receives the click and wheel movement in order.
