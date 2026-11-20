# Onboarding source outcome

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-source-outcome.test.tsx](onboarding-source-outcome.test.tsx).

## onboarding-source-outcome-001

Original test `changing the selected industry updates its outcome without connecting a source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-source-outcome.test.tsx#L77).

- **Given** A user begins onboarding with Google Drive and Google Ads available but has not connected a work source.
- **When** They view the Design & creative example, go Back, and choose Marketing & content.
- **Then** The example changes from a Google Drive client brief for a skincare launch to a Google Ads campaign summary showing ROAS; the former example disappears and Continue remains disabled without a connection.

## onboarding-source-outcome-002

Original test `an unavailable featured source does not advertise an outcome for that source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-source-outcome.test.tsx#L105).

- **Given** A user begins onboarding with Google Ads and Gmail available, but the featured Google Drive source is unavailable.
- **When** They choose Design & creative and reach the work-tool step.
- **Then** No illustrative outcome is shown, Gmail is listed, and Continue remains disabled.

## onboarding-source-outcome-003

Original test `a phone can expand the example while the connection requirement stays in place`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-source-outcome.test.tsx#L121).

- **Given** A user on a phone reaches the work-tool step without connecting a source.
- **When** They expand the example disclosure.
- **Then** The Google Drive creative-brief example appears, while Continue remains disabled and Permissions and privacy is visible.
