# Connector directory

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connector-directory.test.tsx](connector-directory.test.tsx).

## connector-directory-001

Original test `Show builtin tool service details without HTTP permission controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx#L28).

- **Given** A built-in Public Tools service uses public access over streamable HTTP and has an account.
- **When** The user searches for it and opens its details.
- **Then** The Public Tools details appear without a Permissions section or Configure button.

## connector-directory-002

Original test `Offer the catalog for adding, and find a connected connector by name`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx#L122).

- **Given** GitHub is already connected, while Gmail and Notion are not connected.
- **When** The user opens the connector catalog, then searches for GitHub by name.
- **Then** The catalog initially offers addable connectors without listing GitHub; the search finds GitHub and identifies it under Connected.

## connector-directory-003

Original test `Find a connector by a tag that is not in its name`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx#L153).

- **Given** Gmail has the tag “email,” while Notion does not.
- **When** The user searches for “email” in the connector catalog.
- **Then** Gmail appears and Notion does not.

## connector-directory-004

Original test `Open connector detail and step back to the list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx#L174).

- **Given** The connector catalog includes GitHub.
- **When** The user opens GitHub details and then goes back.
- **Then** The GitHub details show Connection and the dialog is named GitHub; returning shows the Connected heading and restores the Connectors dialog.

## connector-directory-005

Original test `Close a shelf with the products behind it, and open that category`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx#L272).

- **Given** The mail category has a shelf with 16 ranked connectors and a total of 327; the voice category has only two catalog connectors, so it does not fill a shelf.
- **When** The user opens the mail shelf’s “See Telegram, Lark and 323 more” control.
- **Then** The mail shelf closes and Test Subdomain appears. Voice has no shelf and is available among More categories.

## connector-directory-006

Original test `Show a connector on one shelf only`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx#L306).

- **Given** Gmail is the leading connector in the head shelf and also belongs to the mail category.
- **When** The user views the connector catalog.
- **Then** Gmail appears only once, rather than being repeated on the mail shelf.

## connector-directory-007

Original test `List the catalog when it is too small for any category to fill a shelf`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx#L328).

- **Given** The catalog has GitHub, Gmail, and Notion, with only two unconnected connectors and no category large enough to earn a shelf.
- **When** The user opens the connector catalog.
- **Then** The catalog lists Notion and Gmail, and no category shelf is shown.

## connector-directory-008

Original test `Count the whole category on a chip, not the slice discovery returned`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx#L349).

- **Given** The catalog labels mail connectors as “communication-collaboration,” and the reported category total is 329, although discovery returns only a slice.
- **When** The user opens the catalog and views that category.
- **Then** The category heading reads “Communication and collaboration,” and its chip shows Communication with the total 329.

## connector-directory-009

Original test `Open full connector categories and switch between them with the keyboard`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx#L389).

- **Given** The Mail category has 16 connectors and Voice has 2; their category totals are 16 and 50, respectively.
- **When** The user focuses the Mail16 chip and presses Enter, then focuses Voice50 and presses Space.
- **Then** The Mail category shows all 16 connector cards, including Help Scout; Voice shows both cards, including 3Scribe.

## connector-directory-010

Original test `Open one provider authorization window from a focused card with Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx#L447).

- **Given** The connector catalog contains Gmail, which supports provider authorization.
- **When** The user tabs to Connect Gmail and presses Enter.
- **Then** One authorization window opens at the Gmail authorization URL and one OAuth connection request is made. Closing the dialog closes the authorization window.

## connector-directory-011

Original test `Keep remote access results outside connector action navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx#L481).

- **Given** The SSH summary reports zero configured connections.
- **When** The user searches the connector catalog for “ssh.”
- **Then** Remote access appears with a Manage SSH hosts link to /connectors?scope=remote-control&type=ssh, and no “No connector matches” message appears.
