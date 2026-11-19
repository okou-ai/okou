# Computer use authorization card

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [computer-use-authorization-card.test.tsx](computer-use-authorization-card.test.tsx).

## computer-use-authorization-card-001

Original test `A user authorizes the only online computer directly in the chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L100).

- **Given** A chat contains a valid authorization request and exactly one online computer.
- **When** The user authorizes it.
- **Then** The computer is authorized, and the card says computer access is enabled for future runs in this chat.

## computer-use-authorization-card-002

Original test `With multiple online computers, a user chooses which one to authorize`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L127).

- **Given** A chat contains a valid authorization request and two online computers, Work Mac and Studio Mac.
- **When** The user selects Studio Mac, then the host list changes to only Work Mac and later returns to both computers.
- **Then** Authorization is initially unavailable until a computer is selected; when Studio Mac disappears, the selection clears and authorization is unavailable, and when it returns, it is selected again. Authorizing then marks the request authorized for Studio Mac.

## computer-use-authorization-card-003

Original test `The card follows the host directory when a computer disconnects and returns`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L179).

- **Given** A chat contains a valid authorization request and its computer is online.
- **When** The computer disconnects and then returns online.
- **Then** While it is offline, the card says there are no online computers and prompts the user to open Okou on the Mac; when it returns, authorization is available again.

## computer-use-authorization-card-004

Original test `An authorization failure stays visible without claiming access was enabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L200).

- **Given** A chat contains a valid authorization request and one online computer.
- **When** The user tries to authorize it, but authorization fails with a forbidden response.
- **Then** The card displays that authorization could not be completed and invites a retry; the Authorize button remains enabled, and the card does not claim access was enabled.

## computer-use-authorization-card-005

Original test `A request from another chat cannot authorize a computer from this card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L218).

- **Given** A chat displays an authorization request scoped to a different chat.
- **When** The card loads the request.
- **Then** It says the authorization link is invalid, expired, or unavailable for the workspace, and offers no buttons.

## computer-use-authorization-card-006

Original test `An older API response without chat scope cannot offer inline authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L227).

- **Given** A chat displays an authorization link, but the API response has no chat scope.
- **When** The card loads the request despite an online computer being available.
- **Then** It says the authorization link is invalid, expired, or unavailable for the workspace, and offers no buttons.

## computer-use-authorization-card-007

Original test `An expired authorization request is unavailable in the transcript`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L254).

- **Given** A chat transcript contains an authorization link whose request has expired.
- **When** The card loads the request and receives an expired response.
- **Then** It says the authorization link is invalid, expired, or unavailable for the workspace, and offers no buttons.

## computer-use-authorization-card-008

Original test `Completed requests remain authorized when the chat is reopened`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L267).

- **Given** A chat is reopened with an authorization request already completed for a computer.
- **When** The card loads the completed request.
- **Then** It shows the request as Authorized, with the button disabled.

## computer-use-authorization-card-009

Original test `Computer authorization resumes only with an explicit callback (false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L275).

- **Given** A chat has a valid authorization request with no callback prompt in its link.
- **When** The user authorizes the only online computer.
- **Then** The request becomes Authorized, and no message is sent to the conversation.

## computer-use-authorization-card-010

Original test `Computer authorization resumes only with an explicit callback (true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L275).

- **Given** A chat has a valid authorization request whose link includes the current chat ID and the callback prompt “Recheck computer access and continue.”
- **When** The user authorizes the only online computer.
- **Then** The request becomes Authorized, and the callback prompt is sent to the conversation exactly once.

## computer-use-authorization-card-011

Original test `A computer callback for another chat cannot authorize from this card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L311).

- **Given** A chat displays an authorization link whose callback specifies a different chat ID.
- **When** The card loads the request.
- **Then** It says the authorization link is invalid, expired, or unavailable for the workspace, and offers no buttons.

## computer-use-authorization-card-012

Original test `A failed computer callback retries the same input without reauthorizing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/computer-use-authorization-card.test.tsx#L322).

- **Given** A chat has a valid authorization request whose callback prompt is “Continue.” The first attempt to send that prompt fails with a service-unavailable response.
- **When** The user authorizes the computer, then retries after the conversation continuation fails.
- **Then** The card reports that access was enabled but the conversation could not continue, and offers a retry. Retrying does not authorize again; it marks the request Authorized and sends the same input twice with the same client event ID.
