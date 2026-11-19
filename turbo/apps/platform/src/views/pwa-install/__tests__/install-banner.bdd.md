# Install banner

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [install-banner.test.tsx](install-banner.test.tsx).

## install-banner-001

Original test `An iOS user can open or dismiss the install prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/pwa-install/__tests__/install-banner.test.tsx#L40).

- **Given** A user visits the app in iOS Safari outside standalone mode.
- **When** The user opens the install prompt, reads the instructions, closes the dialog, and dismisses the banner.
- **Then** The banner offers an install prompt; its dialog instructs the user to tap Safari's Share button and choose Add to Home Screen. Closing the dialog hides it, and dismissing the banner removes it.

## install-banner-002

Original test `The standalone app hides the install banner`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/pwa-install/__tests__/install-banner.test.tsx#L70).

- **Given** A user visits the app in iOS Safari in standalone mode.
- **When** The app loads.
- **Then** Main navigation appears and the install banner is hidden.
