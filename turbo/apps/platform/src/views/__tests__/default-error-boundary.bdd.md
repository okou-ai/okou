# Default error boundary

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [default-error-boundary.test.tsx](default-error-boundary.test.tsx).

## default-error-boundary-001

Original test `The error page does not wait for the workspace worker`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/default-error-boundary.test.tsx#L14).

- **Given** A user opens the error page while the workspace worker remains pending.
- **When** The error page loads.
- **Then** The page shows an alert with “Oops! Something went sideways” and “We're here to help” without waiting for the worker; no Clerk sign-in control appears.

## default-error-boundary-002

Original test `The error page retains support and theme controls (dark: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/default-error-boundary.test.tsx#L47).

- **Given** A user opens the error page with dark theme initially off and no signed-in authentication.
- **When** The user toggles the theme.
- **Then** The alert includes the help message, another-try prompt, and support link to mailto:contact@okou.ai; the Okou home link points to /, and the theme control changes from unpressed to pressed.

## default-error-boundary-003

Original test `The error page retains support and theme controls (dark: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/default-error-boundary.test.tsx#L47).

- **Given** A user opens the error page with dark theme initially on and no signed-in authentication.
- **When** The user toggles the theme.
- **Then** The alert includes the help message, another-try prompt, and support link to mailto:contact@okou.ai; the Okou home link points to /, and the theme control changes from pressed to unpressed.
