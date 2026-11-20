# Computer use authorization page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [computer-use-authorization-page.test.tsx](computer-use-authorization-page.test.tsx).

## computer-use-authorization-page-001

Original test `An Intel Mac cannot download the unsupported computer-use app`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/computer-use-authorization/__tests__/computer-use-authorization-page.test.tsx#L120).

- **Given** An Intel Mac user opens the computer-use authorization page when no computers are online.
- **When** The page checks the user's platform and available computers.
- **Then** It shows “No online computers,” explains that an Apple silicon Mac with macOS 14 or newer is required, disables the “Requires an Apple silicon Mac” button, and provides no download link.

## computer-use-authorization-page-002

Original test `A user with no online computer receives setup guidance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/computer-use-authorization/__tests__/computer-use-authorization-page.test.tsx#L144).

- **Given** The authorization request has an offline computer but no online computers.
- **When** The user opens the computer-use authorization page.
- **Then** It shows “No online computers” and guidance to open Okou on the Mac. The offline computer is not listed, and a link to the Apple silicon macOS app download is shown.

## computer-use-authorization-page-003

Original test `The standalone computer page honors the optional callback (false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/computer-use-authorization/__tests__/computer-use-authorization-page.test.tsx#L177).

- **Given** A standalone computer authorization request has an online computer and is opened without a callback thread or callback prompt.
- **When** The user authorizes the computer.
- **Then** The computer is authorized exactly once and the button becomes disabled as “Authorized.” No callback prompt is sent.

## computer-use-authorization-page-004

Original test `The standalone computer page honors the optional callback (true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/computer-use-authorization/__tests__/computer-use-authorization-page.test.tsx#L177).

- **Given** A standalone computer authorization request has an online computer and is opened with a callback thread and the prompt “Continue.”
- **When** The user authorizes the computer.
- **Then** The computer is authorized exactly once and the button becomes disabled as “Authorized.” The “Continue” callback prompt is sent.
