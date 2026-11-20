# Onboarding capabilities

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-capabilities.test.tsx](onboarding-capabilities.test.tsx).

## onboarding-capabilities-001

Original test `Capabilities lead with Okou's tools, then follow Router order and text (mobile=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-capabilities.test.tsx#L94).

- **Given** A new user opens the capabilities step on desktop with the standard Router catalog available.
- **When** The step loads.
- **Then** The built-in list shows Image generation and Web search first, followed by Router web-extraction, company-contacts, social, finance, and places-weather in that order. All seven switches are on, Okou's Web search description and Router social description are shown, and progress reports 5 of 6.

## onboarding-capabilities-002

Original test `Capabilities lead with Okou's tools, then follow Router order and text (mobile=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-capabilities.test.tsx#L94).

- **Given** A new user opens the capabilities step on mobile with the standard Router catalog available.
- **When** The step loads.
- **Then** The built-in list shows Image generation and Web search first, followed by Router web-extraction, company-contacts, social, finance, and places-weather in that order. All seven switches are on, Okou's Web search description and Router social description are shown, and progress reports 5 of 6.

## onboarding-capabilities-003

Original test `A member's saved choice stays visible while saving and survives Back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-capabilities.test.tsx#L134).

- **Given** A member has Router social turned off and opens the capabilities step.
- **When** The member turns social on while the preference save is still pending, tries Continue, then lets saving finish, continues, and goes Back from the next step.
- **Then** Social stays off while saving, and Continue is disabled and does not navigate. Once saving succeeds, social is on and Continue is enabled; the next step retains the redeem code LAUNCH50, and returning Back shows social still on.

## onboarding-capabilities-004

Original test `A failed preference update retains the previous choice and can be retried`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-capabilities.test.tsx#L181).

- **Given** A new user opens the capabilities step with Image generation enabled.
- **When** The first attempt to turn Image generation off fails, then the user retries.
- **Then** The failed save displays “Your change was not saved.” and leaves Image generation on. The retry turns it off and clears the error.

## onboarding-capabilities-005

Original test `All capabilities can be off and the task and separate output format survive navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-capabilities.test.tsx#L212).

- **Given** A new user has all built-in capabilities disabled and reaches the capabilities step.
- **When** The user goes Back to chat channels, selects Not now, returns to capabilities, continues, enters a task, selects Presentation, then navigates Back and forward again.
- **Then** All capability switches remain off, and navigation through chat channels and capabilities is allowed. The task text and selected Presentation output format survive the navigation.

## onboarding-capabilities-006

Original test `New Router families use their published text and unavailable families stay hidden`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-capabilities.test.tsx#L245).

- **Given** A new user opens capabilities with a Router catalog containing only the previously unknown future-family.
- **When** The catalog loads and the user turns that capability off.
- **Then** Router future-family appears with its published description, Router social remains hidden, and future-family can be switched off.

## onboarding-capabilities-007

Original test `Catalog failure does not block onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-capabilities.test.tsx#L261).

- **Given** A new user opens capabilities while the external catalog request fails with status 500.
- **When** The user continues past the load error.
- **Then** The step displays “Your tool settings could not be loaded.” and still navigates to the first-task step.

## onboarding-capabilities-008

Original test `All new users choose capabilities after chat channels (isAdmin=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-capabilities.test.tsx#L270).

- **Given** A new administrator is onboarding and has reached the capabilities step after chat channels.
- **When** The administrator goes Back, selects Not now on chat channels, returns to capabilities, and continues.
- **Then** Capabilities remains the step after chat channels, and Continue navigates to the first-task step.

## onboarding-capabilities-009

Original test `All new users choose capabilities after chat channels (isAdmin=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-capabilities.test.tsx#L270).

- **Given** A new non-administrator is onboarding and has reached the capabilities step after chat channels.
- **When** The user goes Back, selects Not now on chat channels, returns to capabilities, and continues.
- **Then** Capabilities remains the step after chat channels, and Continue navigates to the first-task step.

## onboarding-capabilities-010

Original test `Opening Settings does not replace the onboarding catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-capabilities.test.tsx#L286).

- **Given** A user is viewing onboarding capabilities with the standard catalog, including Router social.
- **When** The user opens Settings and views Tools after a different Router catalog becomes available.
- **Then** Settings shows Router future-family, while the onboarding catalog still contains Router social and does not contain Router future-family.
