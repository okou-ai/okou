# Connectors accounts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-accounts.test.tsx](connectors-accounts.test.tsx).

## connectors-accounts-001

Original test `Manage each saved account's default availability independently`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L179).

- **Given** A user has Work and Personal GitHub accounts, both enabled by default, and Work is the saved default.
- **When** They open account management and disable Work.
- **Then** Work is unchecked while Personal remains checked. The manager explains that these choices control which GitHub accounts Okou can use across chats and can be changed per chat.

## connectors-accounts-002

Original test `Disable all saved accounts and enable an account again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L196).

- **Given** A user has Work and Personal GitHub accounts, with only Personal enabled by default.
- **When** They disable Personal, then enable Work.
- **Then** Both accounts are unchecked after disabling Personal, and Work becomes checked when enabled.

## connectors-accounts-003

Original test `Disconnect an account while retaining another enabled account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L209).

- **Given** A user has Work and Personal GitHub accounts, with Work enabled by default and Personal initially disabled.
- **When** They enable Personal, then disconnect Work.
- **Then** Work is removed from the manager and Personal remains enabled.

## connectors-accounts-004

Original test `Keep the exact account and current reconnect UI when future setup metadata is present`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L299).

- **Given** A GitHub account named Prepared work account is marked as requiring reconnection and includes setup metadata for an access token, with no required fields missing.
- **When** The user opens account management while its account list is still loading.
- **Then** The connector card says Connected, the manager shows an accounts-loading status, and after loading it shows Prepared work account with an enabled Reconnect button.

## connectors-accounts-005

Original test `Show Mercury disclosures while managing its accounts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L349).

- **Given** A connected Mercury account is available.
- **When** The user opens Mercury account management and then Mercury access management.
- **Then** The Mercury link points to https://mercury.com in the connector card and both dialogs. Account management displays the fintech and FDIC banking-services disclosure.

## connectors-accounts-006

Original test `Show the full agent name after granting the first connector access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L478).

- **Given** A GitHub connector access summary is open for an agent with a long name, and the connector initially says Add access.
- **When** The user grants GitHub access to that agent and closes the dialog.
- **Then** The connector access summary displays “Used by” followed by the agent’s full name.

## connectors-accounts-007

Original test `Make another connector account the default with pointer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L597).

- **Given** Work is the selected default GitHub account, and Personal is another account.
- **When** The user selects Personal with a pointer while the default change is pending, then waits for it to finish.
- **Then** Both choices are temporarily disabled and Work remains selected until completion. Personal then becomes the default, Work appears only once, and the connector remains Connected; selecting the already-default Personal account leaves it selected.

## connectors-accounts-008

Original test `Make another connector account the default with Space`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L597).

- **Given** Work is the selected default GitHub account, and Personal is another account.
- **When** The user focuses Personal and presses Space while the default change is pending, then waits for it to finish.
- **Then** Both choices are temporarily disabled and Work remains selected until completion. Personal then becomes the default, Work appears only once, and the connector remains Connected; selecting the already-default Personal account leaves it selected.

## connectors-accounts-009

Original test `Make another connector account the default with ArrowDown`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L597).

- **Given** Work is the selected default GitHub account, and Personal is another account.
- **When** The user focuses Work and presses ArrowDown while the default change is pending, then waits for it to finish.
- **Then** Both choices are temporarily disabled and Work remains selected until completion. Personal then becomes the default, Work appears only once, and the connector remains Connected; selecting the already-default Personal account leaves it selected.

## connectors-accounts-010

Original test `Keep ArrowDown navigation on the focused account after default-first reordering`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L643).

- **Given** Work is the default GitHub account and the account list is ordered default-first.
- **When** The user focuses Work and presses ArrowDown twice, observing the selection after each key press.
- **Then** The first press selects and focuses Personal, which moves to the first row; the second selects and focuses Work, which moves to the first row.

## connectors-accounts-011

Original test `Keep ArrowRight navigation on the focused account after default-first reordering`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L643).

- **Given** Work is the default GitHub account and the account list is ordered default-first.
- **When** The user focuses Work and presses ArrowRight twice, observing the selection after each key press.
- **Then** The first press selects and focuses Personal, which moves to the first row; the second selects and focuses Work, which moves to the first row.

## connectors-accounts-012

Original test `Keep ArrowUp navigation on the focused account after default-first reordering`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L643).

- **Given** Work is the default GitHub account and the account list is ordered default-first.
- **When** The user focuses Work and presses ArrowUp twice, observing the selection after each key press.
- **Then** The first press selects and focuses Personal, which moves to the first row; the second selects and focuses Work, which moves to the first row.

## connectors-accounts-013

Original test `Keep ArrowLeft navigation on the focused account after default-first reordering`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L643).

- **Given** Work is the default GitHub account and the account list is ordered default-first.
- **When** The user focuses Work and presses ArrowLeft twice, observing the selection after each key press.
- **Then** The first press selects and focuses Personal, which moves to the first row; the second selects and focuses Work, which moves to the first row.

## connectors-accounts-014

Original test `Keep the saved default account after a rejected change and allow retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L669).

- **Given** Work is the saved default GitHub account and Personal is another account.
- **When** A change to Personal is rejected, then the user retries selecting Personal.
- **Then** The rejected change leaves Work selected and labeled Default, while Personal is labeled Make default. The retry succeeds and Personal becomes selected.

## connectors-accounts-015

Original test `Grant and revoke connector access for agents`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L698).

- **Given** Research Agent already has GitHub access and Support Agent does not.
- **When** The user opens GitHub access management and grants access to Support Agent.
- **Then** Both agents are shown; Research Agent has a revoke control, and Support Agent’s control changes to revoke after access is granted.

## connectors-accounts-016

Original test `Load connector accounts progressively`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L778).

- **Given** Eight GitHub accounts are available, returned in pages of three, with the default account among them.
- **When** The user opens account management and loads more accounts twice.
- **Then** Initially Work 7 is shown and Work 4 is not. After the first load, Work 4 appears; after the second, Work 1 appears, Load more is gone, exactly one account is named Unnamed account, and all eight account actions are available.

## connectors-accounts-017

Original test `Rename a specific connector account to a new label`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L926).

- **Given** A specific GitHub account is available for renaming.
- **When** The user changes its account name to Personal and saves.
- **Then** The manager displays Personal.

## connectors-accounts-018

Original test `Keep a failed connector disconnect open and finish a successful retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L939).

- **Given** A GitHub account named octocat has two threads that will return to default inheritance if disconnected.
- **When** The user starts disconnecting it, the first attempt fails, and the user retries successfully.
- **Then** The confirmation explains that the Okou connection is removed, two threads return to default inheritance, and the provider account is not deleted. While the request is pending the disconnect button is disabled; on failure the dialog stays open with “Disconnect failed” and an enabled retry. The successful retry leaves no accounts, enables Add account, and closes the confirmation.

## connectors-accounts-019

Original test `Keep another account's confirmation open when an earlier disconnect finishes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L999).

- **Given** Work and Personal GitHub accounts are available. Disconnecting Work is pending, and its confirmation is canceled before the request finishes.
- **When** The user opens a disconnect confirmation for Personal, then the earlier Work deletion completes.
- **Then** The Personal confirmation remains open and its disconnect button becomes enabled. Personal remains listed and Work is removed.

## connectors-accounts-020

Original test `Review and reconnect the connector account the user selected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L1108).

- **Given** Work is the default GitHub account, while Personal has a scope mismatch and a permission difference that adds read:user.
- **When** The user reviews Personal’s permissions, reconnects from the review, and starts the reconnect flow.
- **Then** The review shows read:user, and the reconnect authorization URL opens. The reconnect request targets Personal’s connection ID with intent reconnect.

## connectors-accounts-021

Original test `Let account search own the entire manager result list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L1206).

- **Given** Seven GitHub accounts are available, including the default named Primary.
- **When** The user searches for a name with no matches, then searches for Primary.
- **Then** The unmatched search shows No accounts found and does not show Primary. Searching Primary shows that account and removes the empty-result message.

## connectors-accounts-022

Original test `Keep the canonical default visible when it is outside the loaded account page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L1255).

- **Given** The canonical default GitHub account is outside the loaded account results and has no display name.
- **When** The user opens the manager, then searches for Work 1.
- **Then** The default is initially visible as Unnamed account and selected as Default. The search shows Work 1 and hides Unnamed account.

## connectors-accounts-023

Original test `Manage connector accounts and agent access independently`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L1304).

- **Given** GitHub has seven saved accounts, including an unnamed default account that requires reconnection.
- **When** The user opens access management, closes it, and opens account management.
- **Then** Access management opens without account management also being open. Account management shows the unnamed default with Reconnect required, and exactly one account is named Unnamed account.

## connectors-accounts-024

Original test `Manage access for a connector without configurable permissions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L1364).

- **Given** Cloudinary access is enabled for Media Agent, and Cloudinary does not have configurable permissions.
- **When** The user opens Cloudinary access management.
- **Then** Media Agent is shown with a revoke control. The dialog does not show Allowed or a Manage button.

## connectors-accounts-025

Original test `Prevent account additions when a connector target is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L1406).

- **Given** The GitHub connector target is unavailable and the account-list request returns not found.
- **When** The user opens GitHub account management.
- **Then** The manager says accounts are unavailable for this connector, and Add account is disabled.

## connectors-accounts-026

Original test `Read accounts only inside the manager and refresh them each time it opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L1431).

- **Given** A connected GitHub account is named Work.
- **When** The user opens and closes account management, the account name changes elsewhere to Updated elsewhere, and the user reopens the manager.
- **Then** Work is not shown on the connector page before opening the manager. The first manager shows Work; the reopened manager shows Updated elsewhere and no longer shows Work.

## connectors-accounts-027

Original test `Apply one agent's GitHub permissions from connector access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L1478).

- **Given** Research Agent has GitHub access, and its available GitHub permission issues|read currently has the default allow policy.
- **When** The user opens GitHub access management, changes issues|read to Deny for Research Agent, and applies the change.
- **Then** The app reports “Permissions updated,” sends a patch denying issues|read for Research Agent, closes the permissions dialog, and leaves GitHub access management open.
