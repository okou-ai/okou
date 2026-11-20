# User timezone initialization

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [user-timezone-initialization.test.tsx](user-timezone-initialization.test.tsx).

## user-timezone-initialization-001

Original test `A member's first organization visit stores the browser timezone`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/bootstrap/__tests__/user-timezone-initialization.test.tsx#L95).

- **Given** A member visits an organization for the first time with no stored timezone, an English locale, and a browser timezone of Asia/Shanghai.
- **When** The Agents page loads.
- **Then** Preferences initialize with timezone Asia/Shanghai and locale en-US. The preferences are read once and no update request is made.
- **Upstream change** `4e5707de` (#49556) retires the multi-agent Agents page, so `/agents` now only redirects to Home with My Okou settings open; the upstream test is now `A member's first organization visit stores the browser timezone` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/signals/bootstrap/__tests__/user-timezone-initialization.test.tsx#L95)), which loads `/workflows`. Rebuild this scenario loading the Workflows page (Workflows heading) instead of the Agents page.

## user-timezone-initialization-002

Original test `An initialized member without memory initializes it without replacing preferences`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/bootstrap/__tests__/user-timezone-initialization.test.tsx#L114).

- **Given** A member has timezone America/Los_Angeles and locale en-US already stored, but memory has not been initialized; the browser timezone is Asia/Shanghai.
- **When** The Agents page loads.
- **Then** Memory becomes initialized without replacing the stored timezone or locale. Preferences are read once and no update request is made.

## user-timezone-initialization-003

Original test `A stored organization timezone is not replaced on a later visit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/bootstrap/__tests__/user-timezone-initialization.test.tsx#L135).

- **Given** A member has timezone America/Los_Angeles and locale en-US stored, while the browser timezone is Asia/Shanghai.
- **When** The member visits Agents with the settings preference dialog open.
- **Then** Settings displays Pacific Time (PT); no initialization or update request is made, and preferences are read once.

## user-timezone-initialization-004

Original test `A missing locale initializes without replacing the stored timezone`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/bootstrap/__tests__/user-timezone-initialization.test.tsx#L154).

- **Given** A member has timezone America/Los_Angeles but no stored locale; the browser timezone is Asia/Shanghai and the browser's preferred language is fr-FR.
- **When** The Agents page loads.
- **Then** Preferences initialize with locale fr-FR while retaining timezone America/Los_Angeles. Preferences are read once and no update request is made.
