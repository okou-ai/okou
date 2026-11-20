# Connectors directory custom

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-directory-custom.test.tsx](connectors-directory-custom.test.tsx).

## connectors-directory-custom-001

Original test `Custom scope lists custom connectors and offers custom creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-directory-custom.test.tsx#L41).

- **Given** Custom connectors include Acme Reports.
- **When** The user opens the Custom scope.
- **Then** Acme Reports is listed, and a New custom connector action is available.

## connectors-directory-custom-002

Original test `Separate same-name built-in and custom search results`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-directory-custom.test.tsx#L54).

- **Given** The built-in GitHub connector and a custom connector are both named Acme Reports.
- **When** The user searches for “acme” across connectors.
- **Then** Acme Reports appears in both the Built-in connectors and Custom sections, with no no-match message.

## connectors-directory-custom-003

Original test `Keep zero-custom navigation and role-specific creation for admin`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-directory-custom.test.tsx#L74).

- **Given** An admin opens the connector catalog with no custom connectors and GitHub available.
- **When** The admin selects the Custom scope.
- **Then** The Custom section appears, GitHub is absent, and the URL reflects the Custom scope. The admin sees “Add an HTTP API or MCP server for your organization to use.” and a New custom connector action.

## connectors-directory-custom-004

Original test `Keep zero-custom navigation and role-specific creation for member`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-directory-custom.test.tsx#L74).

- **Given** A member opens the connector catalog with no custom connectors and GitHub available.
- **When** The member selects the Custom scope.
- **Then** The Custom section appears, GitHub is absent, and the URL reflects the Custom scope. The member sees “Your org hasn't registered any custom connectors yet.” and no New custom connector action.

## connectors-directory-custom-005

Original test `Honor Custom deep links, scoped search, and returning to All`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-directory-custom.test.tsx#L111).

- **Given** The user opens a Custom deep link filtered to the Other category and “acme”; Acme Reports is a custom connector and GitHub is built-in.
- **When** The user searches for “missing” within Custom, then returns to All connectors.
- **Then** Acme Reports appears initially while GitHub does not. The scoped search shows “No custom connectors match your search.” and still offers New custom connector. Returning to All shows GitHub and clears the scope, category, and keyword URL parameters.

## connectors-directory-custom-006

Original test `Keep category search scoped and offer All for a custom-only match`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-directory-custom.test.tsx#L142).

- **Given** Acme Reports is a custom connector, and the user searches for “acme” in the Engineering category.
- **When** The user chooses Search all connectors after the category search finds no match.
- **Then** The category view says “No connectors match in this category,” shows neither Acme Reports nor New custom connector, and Search all connectors reveals Acme Reports while retaining the “acme” keyword.

## connectors-directory-custom-007

Original test `Scope navigation returns directly to Remote control`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-directory-custom.test.tsx#L160).

- **Given** The user is viewing the connector directory with custom connectors available.
- **When** The user navigates to Remote control, then to Custom, and uses browser Back.
- **Then** Remote control offers Add connection; Custom shows Acme Reports and has the URL “?scope=custom”. Back returns directly to Remote control, where Add connection remains available and Acme Reports is absent.

## connectors-directory-custom-008

Original test `Do not turn Custom loading failure into an empty search result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-directory-custom.test.tsx#L181).

- **Given** The Custom connector list request fails while the user opens the directory with the keyword “recovered”.
- **When** The Custom section finishes loading.
- **Then** It displays “Couldn't load custom connectors.” and does not show a no-connectors-matching message.

## connectors-directory-custom-009

Original test `Keep Remote control and Custom in separate scopes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-directory-custom.test.tsx#L204).

- **Given** The directory has custom connectors and no configured remote-control connections.
- **When** The user selects Remote control.
- **Then** The URL indicates the Remote control scope and Add connection is available. The Custom section and New custom connector action are absent both before and after selecting Remote control.

## connectors-directory-custom-010

Original test `Cancel and create a custom connector from the Custom scope`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-directory-custom.test.tsx#L223).

- **Given** The user is in the Custom scope with the keyword “missing” and no listed connectors.
- **When** The user opens and cancels New custom connector, then opens it again and creates “Created Service” with an HTTPS prefix and API authentication.
- **Then** Cancel closes the dialog and preserves the keyword. Creation displays a Created Service card showing “No accounts” and leaves the user in the Custom scope.

## connectors-directory-custom-011

Original test `Search custom display names without matching endpoints or slugs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-directory-custom.test.tsx#L264).

- **Given** Acme Reports has the display name “Acme Reports” and slug “hidden-slug”; Other Service has an endpoint under acme-reports.test.
- **When** The user searches for “aCmE” with surrounding whitespace, then searches for “hidden-slug”.
- **Then** The first search shows Acme Reports but not Other Service, with no no-match message. Searching the slug shows a no-match message and no Acme Reports card; New custom connector still opens its creation dialog.
