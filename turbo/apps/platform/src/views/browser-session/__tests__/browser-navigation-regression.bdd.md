# Browser navigation regression

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-navigation-regression.test.tsx](browser-navigation-regression.test.tsx).

## browser-navigation-regression-01

Original test `The address bar submits %s through the native form without a keydown`.

- **Given** The viewer is open.
- **When** The user submits the address form without a keydown.
- **Then** The address field shows the normalized destination and remains usable.

Examples

- `browser-navigation-regression-01.01` google.com opens http://google.com/
  Registered test `The address bar submits google.com through the native form without a keydown`.
- `browser-navigation-regression-01.02` https://google.com opens https://google.com/
  Registered test `The address bar submits https://google.com through the native form without a keydown`.

## browser-navigation-regression-02

Original test `A pending initial history response does not block live remote input`.

Registered test `A pending initial history response does not block live remote input`.

- **Given** Initial history is still loading.
- **When** The user types into the remote page.
- **Then** Text reaches that page and the address remains usable. When history arrives, the confirmed URL is shown.

Batch 36 accepted this selected ID as the substitute for browser-viewer-binding-002. The remaining selected IDs keep this BDD open.

## browser-navigation-regression-03

Original test `A history failure has local feedback without disabling live input`.

Registered test `A history failure has local feedback without disabling live input`.

- **Given** Initial history fails to load.
- **When** The user types into the remote page before and after the notice expires.
- **Then** Input remains available and the local notice clears on its own.

## browser-navigation-regression-04

Original test `A failed Reload is cleared by %s`.

- **Given** Reload failed but input stayed available.
- **When** The user takes a recovery action.
- **Then** The active address changes, input remains available, and the reload notice clears.

Examples

- `browser-navigation-regression-04.01` Submit a working address
  Registered test `A failed Reload is cleared by successful submission`.
- `browser-navigation-regression-04.02` Select another tab
  Registered test `A failed Reload is cleared by another tab`.

## browser-navigation-regression-05

Original test `A download acknowledgement preserves the confirmed document address without history`.

Registered test `A download acknowledgement preserves the confirmed document address without history`.

- **Given** The current document has a confirmed address but no usable history.
- **When** The user enters a URL that starts a download.
- **Then** The original tab stays selected and its address remains in the usable address bar.

## browser-navigation-regression-06

Original test `A redirect shows its committed URL after the navigation receipt`.

Registered test `A redirect shows its committed URL after the navigation receipt`.

- **Given** The viewer is open.
- **When** The user navigates to a URL that redirects before the initial navigation is acknowledged.
- **Then** The destination tab becomes selected and the address field stays enabled. Once acknowledged, the address shows the final URL.
