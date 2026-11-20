# Billing plans entry

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [billing-plans-entry.test.tsx](billing-plans-entry.test.tsx).

## billing-plans-entry-001

Original test `Dismissing the sidebar upgrade flow returns to the chat screen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-plans-entry.test.tsx#L92).

- **Given** The user is on an agent chat screen with the Pro upgrade option available.
- **When** They open the plan-selection dialog from the sidebar upgrade card and close it.
- **Then** The dialog closes, Settings does not open, and the URL does not retain the billing-settings parameter.

## billing-plans-entry-002

Original test `An admin on mobile navigation opens the plans from Me`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-plans-entry.test.tsx#L116).

- **Given** An admin is on the Me page with mobile navigation and the Pro upgrade option available.
- **When** They choose the upgrade card.
- **Then** The Choose a plan dialog opens.

## billing-plans-entry-003

Original test `Delayed eligibility and catalog loading lead to plan selection and configuration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-plans-entry.test.tsx#L132).

- **Given** The user opens the upgrade flow while billing eligibility and the usage-pack catalog are still loading.
- **When** Eligibility finishes first, then the catalog loads; the user selects Pro, returns to plan selection, and closes it.
- **Then** A loading status appears initially. Plan selection opens without the Pro option until the catalog loads; then Pro can be selected into step 2, and Back returns to step 1 with Pro available. Closing the flow leaves no dialog open.

## billing-plans-entry-004

Original test `A failed eligibility request does not become a normal plan checkout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-plans-entry.test.tsx#L191).

- **Given** The user opens the upgrade flow and the billing eligibility request is pending.
- **When** The eligibility request fails.
- **Then** The Billing dialog reports that billing status could not be loaded, offers no Start with Pro option, and remains the only dialog until closed. Closing it leaves no dialog open and removes the billing-settings parameter from the URL.

## billing-plans-entry-005

Original test `Closing pending eligibility does not reopen the modal when the response arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-plans-entry.test.tsx#L224).

- **Given** The user opens the upgrade flow while billing eligibility is pending.
- **When** They close the pending dialog before eligibility responds, then start the upgrade flow again after the response arrives.
- **Then** The closed dialog does not reopen when the response arrives. Starting the flow again opens one Choose a plan dialog at step 1 with Start with Pro available.

## billing-plans-entry-006

Original test `Loading a applying migration shows progress without allowing a new checkout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-plans-entry.test.tsx#L252).

- **Given** The user opens the upgrade flow while a legacy-plan migration is pending; the migration status is applying.
- **When** The migration response arrives and the user goes back from its progress dialog.
- **Then** The Convert legacy plan dialog shows progress without a Start with Pro option. Going back closes the dialog and does not leave the billing-settings parameter in the URL.

## billing-plans-entry-007

Original test `Loading a scheduled migration shows progress without allowing a new checkout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-plans-entry.test.tsx#L252).

- **Given** The user opens the upgrade flow while a legacy-plan migration is pending; the migration status is scheduled.
- **When** The migration response arrives and the user goes back from its progress dialog.
- **Then** The Convert legacy plan dialog shows progress without a Start with Pro option. Going back closes the dialog and does not leave the billing-settings parameter in the URL.

## billing-plans-entry-008

Original test `A progress-only migration opened inside Settings returns to the billing tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-plans-entry.test.tsx#L291).

- **Given** The user opens Settings on the Billing tab while a scheduled legacy-plan migration exists.
- **When** They open the migration progress dialog from Compare all plans and close it.
- **Then** Settings returns to the Billing tab, the migration dialog closes, and the billing-settings parameter remains in the URL.

## billing-plans-entry-009

Original test `A billing refresh preserves configuration and keyboard focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-plans-entry.test.tsx#L324).

- **Given** The user has advanced to step 2 of Pro member-package configuration and the Close control has keyboard focus.
- **When** A billing-changed event triggers a billing refresh that remains pending and then completes.
- **Then** The configuration stays open at step 2 during and after the refresh, and keyboard focus remains on the Close control.
