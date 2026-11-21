# Sidebar account credits

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-account-credits.test.tsx](sidebar-account-credits.test.tsx).

## sidebar-account-credits-001

Original test `Show a member’s latest package credits in the account menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-credits.test.tsx#L26).

- **Given** A member has 20,400 package credits, later updated to 500 credits, and package credits are enabled.
- **When** They open the account menu, close it, reopen it after the credit change, and select the package credit item.
- **Then** The menu first shows 20,400 credits, then shows 500 credits after reopening; selecting it opens Credit balance with the usage-package credit card.

## sidebar-account-credits-002

Original test `Combine workspace and member-package credits for administrators`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-credits.test.tsx#L105).

- **Given** An administrator has 12,500 workspace credits and 20,400 member-package credits.
- **When** They open the account menu.
- **Then** The combined balance shown is 32,900 credits.

## sidebar-account-credits-003

Original test `Organization debt -23000 does not cancel 50000 prepaid member credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-credits.test.tsx#L138).

- **Given** An administrator’s workspace balance is -23,000 credits and their member package has 50,000 prepaid credits.
- **When** They open the account menu.
- **Then** The member-package balance remains 50,000 credits despite the workspace debt.

## sidebar-account-credits-004

Original test `Organization debt -23000 does not cancel 0 prepaid member credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-credits.test.tsx#L138).

- **Given** An administrator’s workspace balance is -23,000 credits and their member package has 0 prepaid credits.
- **When** They open the account menu.
- **Then** The member-package balance remains 0 credits despite the workspace debt.

## sidebar-account-credits-005

Original test `Export account data from the account menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-credits.test.tsx#L172).

- **Given** An administrator opens the account menu, which shows a 12,500-credit balance and an Export data action.
- **When** They select Export data.
- **Then** A browser window opens a URL ending in /export.

## sidebar-account-credits-006

Original test `Open workspace Credit balance from the account menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-credits.test.tsx#L206).

- **Given** An administrator opens the account menu and sees 12,500 credits.
- **When** They select the credit balance.
- **Then** Settings opens to Credit balance and displays the credit-balance information and 12,500 credits.
