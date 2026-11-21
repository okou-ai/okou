# Chat composer connector focus

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-connector-focus.test.tsx](chat-composer-connector-focus.test.tsx).

## chat-composer-connector-focus-001

Original test `connector search, Chat accounts=false > keeps filtered connectors accessible without losing search focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L108).

- **Given** Chat accounts are disabled. The connector dialog is open with 21 connectors, and loading has completed; the search contains “Focus app 20.”
- **When** The user views the filtered connector results.
- **Then** The search retains focus, and the connector list contains “Focus app 20.”

## chat-composer-connector-focus-002

Original test `connector search, Chat accounts=false > focuses the loaded connector search during reopen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L117).

- **Given** Chat accounts are disabled. The connector dialog is open after loading, and the search contains “Focus app 20.”
- **When** The user closes the dialog with Escape and reopens it.
- **Then** The search receives focus and is empty.

## chat-composer-connector-focus-003

Original test `connector search, Chat accounts=false > does not take focus after keyboard navigation when search loads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L133).

- **Given** Chat accounts are disabled. The connector dialog is open while connector loading is pending, and the Add connectors control is focused after Tab navigation.
- **When** Loading completes and the connector search appears.
- **Then** Focus remains on Add connectors.

## chat-composer-connector-focus-004

Original test `connector search, Chat accounts=false > preserves trigger focus when closed before loading`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L148).

- **Given** Chat accounts are disabled. The connector dialog is open while connector loading is pending.
- **When** The user closes it with Escape before loading completes, then loading completes.
- **Then** The dialog remains closed and focus remains on the Connectors trigger.

## chat-composer-connector-focus-005

Original test `connector search, Chat accounts=false > keeps mobile connector search unfocused after loading`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L160).

- **Given** Chat accounts are disabled. On a touch-pointer device, the connector dialog is open while loading is pending.
- **When** Loading completes and the connector search appears.
- **Then** The search does not receive focus.

## chat-composer-connector-focus-006

Original test `connector search, Chat accounts=true > keeps filtered connectors accessible without losing search focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L108).

- **Given** Chat accounts are enabled. The connector dialog is open with 21 connectors, and loading has completed; the search contains “Focus app 20.”
- **When** The user views the filtered connector results.
- **Then** The search retains focus, and the connector list contains “Focus app 20.”

## chat-composer-connector-focus-007

Original test `connector search, Chat accounts=true > focuses the loaded connector search during reopen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L117).

- **Given** Chat accounts are enabled. The connector dialog is open after loading, and the search contains “Focus app 20.”
- **When** The user closes the dialog with Escape and reopens it.
- **Then** The search receives focus and is empty.

## chat-composer-connector-focus-008

Original test `connector search, Chat accounts=true > does not take focus after keyboard navigation when search loads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L133).

- **Given** Chat accounts are enabled. The connector dialog is open while connector loading is pending, and the Add connectors control is focused after Tab navigation.
- **When** Loading completes and the connector search appears.
- **Then** Focus remains on Add connectors.

## chat-composer-connector-focus-009

Original test `connector search, Chat accounts=true > preserves trigger focus when closed before loading`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L148).

- **Given** Chat accounts are enabled. The connector dialog is open while connector loading is pending.
- **When** The user closes it with Escape before loading completes, then loading completes.
- **Then** The dialog remains closed and focus remains on the Connectors trigger.

## chat-composer-connector-focus-010

Original test `connector search, Chat accounts=true > keeps mobile connector search unfocused after loading`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L160).

- **Given** Chat accounts are enabled. On a touch-pointer device, the connector dialog is open while loading is pending.
- **When** Loading completes and the connector search appears.
- **Then** The search does not receive focus.

## chat-composer-connector-focus-011

Original test `Searching connector names returns from account navigation to connector results`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L175).

- **Given** Chat accounts are enabled. The connector dialog is open, connector loading has completed, and the search can filter 21 connector names.
- **When** The user searches for “Focus app 20,” opens that connector’s account access, then searches for “Focus app 1” and presses Escape.
- **Then** The “Focus app 20 account access” switch appears while navigating its account settings. The results subsequently contain “Focus app 1” and exclude “Focus app 20”; Escape closes the dialog and returns focus to the Connectors trigger.
