# Markdown table export

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [markdown-table-export.test.tsx](markdown-table-export.test.tsx).

## markdown-table-export-001

Original test `Each table footer reports its own data rows and columns`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L278).

- **Given** A chat contains two Markdown tables: one with two data rows and two columns, and another with one data row and two columns.
- **When** The tables are displayed.
- **Then** Each table footer reports its own dimensions: “2 rows · 2 columns” and “1 row · 2 columns.”

## markdown-table-export-002

Original test `A header-only table reports zero data rows and one column`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L284).

- **Given** A chat contains a one-column table with a header and no data rows.
- **When** The table is displayed.
- **Then** Its footer reports “0 rows · 1 column,” and its Export control is enabled.

## markdown-table-export-003

Original test `Raw HTML table dimensions: headerless body`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L372).

- **Given** A raw HTML table has a body row with two data cells and no header.
- **When** The table is displayed.
- **Then** Its footer reports “1 row · 2 columns.”

## markdown-table-export-004

Original test `Raw HTML table dimensions: multiple merged header rows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L372).

- **Given** A raw HTML table has two header rows, with the first header spanning two rows and another spanning two columns, plus one three-cell body row.
- **When** The table is displayed.
- **Then** Its footer reports “1 row · 3 columns.”

## markdown-table-export-005

Original test `Raw HTML table dimensions: body row spans`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L372).

- **Given** A raw HTML table has two body rows; a cell in the first row spans both rows, and the second row contains two other cells.
- **When** The table is displayed.
- **Then** Its footer reports “2 rows · 3 columns.”

## markdown-table-export-006

Original test `Raw HTML table dimensions: implicit column headers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L372).

- **Given** A raw HTML table has a header row without an explicit table section and one two-cell body row.
- **When** The table is displayed.
- **Then** Its footer reports “1 row · 2 columns.”

## markdown-table-export-007

Original test `Raw HTML table dimensions: row headers without data cells`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L372).

- **Given** A raw HTML table has two body rows, each containing only a row header and no data cells.
- **When** The table is displayed.
- **Then** Its footer reports “2 rows · 1 column.”

## markdown-table-export-008

Original test `Raw HTML table dimensions: case-insensitive row and rowgroup scopes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L372).

- **Given** A raw HTML table has two body rows containing row headers whose scope values are “ROW” and “RoWgRoUp.”
- **When** The table is displayed.
- **Then** Its footer reports “2 rows · 1 column.”

## markdown-table-export-009

Original test `Raw HTML table dimensions: fully spanned body rows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L372).

- **Given** A raw HTML table has two body rows, with both cells in the first row spanning both rows and the second row empty.
- **When** The table is displayed.
- **Then** Its footer reports “2 rows · 2 columns.”

## markdown-table-export-010

Original test `Raw HTML table dimensions: empty footer rows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L372).

- **Given** A raw HTML table has one two-cell body row and an empty footer row.
- **When** The table is displayed.
- **Then** Its footer reports “2 rows · 2 columns.”

## markdown-table-export-011

Original test `Raw HTML table dimensions: row headers spanning the rest of their …`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L372).

- **Given** A raw HTML table has three body rows; a row header in the first row has rowspan zero and spans the rest of its body group.
- **When** The table is displayed.
- **Then** Its footer reports “3 rows · 3 columns.”

## markdown-table-export-012

Original test `Raw HTML table dimensions: row spans bounded to their section and …`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L372).

- **Given** A raw HTML table has a header cell with rowspan zero in the header section, one two-cell body row, and one two-cell footer row.
- **When** The table is displayed.
- **Then** Its footer reports “2 rows · 2 columns.”

## markdown-table-export-013

Original test `Keyboard activation of footer Export preserves the menu and dismissal focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L377).

- **Given** A chat displays a table with an Export control.
- **When** The user focuses Export and presses Arrow Down, then presses Escape in the open menu.
- **Then** The menu opens with Export Excel focused and both Google save options present. Escape closes the menu and returns focus to Export.

## markdown-table-export-014

Original test `Each table exports its own real workbook with literal values and source URLs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L406).

- **Given** A chat contains two tables: the first includes Chinese text, a profile link, a number with leading zeros, and formula-like text; the second contains a separate plan and price table.
- **When** The user exports the second table to Excel, then exports the first table to Excel.
- **Then** Each download is a real XLSX named “Table.xlsx.” The second workbook contains only its table’s literal cell values; the first contains its own values, with the profile URL included in the link text and all six values stored as inline strings. Both exports are recorded as spreadsheet downloads from an inline table.

## markdown-table-export-015

Original test `Cloud exports preserve the selected account and upload mode (ready)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L469).

- **Given** A table is available, and the Google account is ready without an existing saved connection.
- **When** The user saves the table to Google Drive and then to Google Sheets.
- **Then** Both saves use the selected account and the corresponding Drive or Sheets upload mode, and each success notice links to the URL returned for that destination. No connection popup is opened.

## markdown-table-export-016

Original test `Cloud exports preserve the selected account and upload mode (authorize)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L469).

- **Given** A table is available, and Google authorization is required before saving.
- **When** The user saves the table to Google Drive and then to Google Sheets, authorizing when prompted.
- **Then** Both saves use the selected account and the corresponding Drive or Sheets upload mode, and each success notice links to the URL returned for that destination. No connection popup is opened.

## markdown-table-export-017

Original test `Cloud exports preserve the selected account and upload mode (connect)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L469).

- **Given** A table is available, and a Google account connection is required before saving.
- **When** The user chooses a Google save destination, connects the account, and saves to Google Drive and Google Sheets.
- **Then** Each save uses the selected account and the corresponding upload mode, and each success notice links to the returned destination URL. Connecting opens one popup, and the other save requires no additional connection popup.

## markdown-table-export-018

Original test `Cloud exports preserve the selected account and upload mode (reconnect)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L469).

- **Given** A table is available, and its Google account requires reconnection.
- **When** The user chooses a Google save destination, reconnects the account, and saves to Google Drive and Google Sheets.
- **Then** Each save uses the selected account and the corresponding upload mode, and each success notice links to the returned destination URL. Reconnection opens one popup, and the other save requires no additional connection popup.

## markdown-table-export-019

Original test `Repeating Save to Google Drive after success shows the new response link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L619).

- **Given** A table has been saved to Google Drive and the first response includes a link.
- **When** The user saves the same table to Google Drive again and the second response includes a different link.
- **Then** The second success notice shows the new response link, and Google Drive remains available to save again.

## markdown-table-export-020

Original test `Repeating Save to Google Sheets after success shows the new response link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L619).

- **Given** A table has been saved to Google Sheets and the first response includes a link.
- **When** The user saves the same table to Google Sheets again and the second response includes a different link.
- **Then** The second success notice shows the new response link, and Google Sheets remains available to save again.

## markdown-table-export-021

Original test `Interleaving two tables and Google destinations shows the matching success links`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L648).

- **Given** A chat contains two tables, each with its own artifact, and both Google Drive and Google Sheets destinations are available.
- **When** The user saves the first table to Drive, the second to Sheets, the first to Sheets, and the second to Drive.
- **Then** Each success notice links to the matching table’s link for the selected destination. After these saves, the first table’s menu can remain open while the second table’s Export control stays enabled.

## markdown-table-export-022

Original test `An unconfirmed Sheets conversion can be retried after saving to Drive`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L696).

- **Given** A table is saved to Drive, and a Sheets save returns a Drive file rather than confirming conversion to a spreadsheet.
- **When** The user retries saving to Sheets after the conversion warning, and the retry confirms conversion.
- **Then** The first Sheets attempt displays “Google conversion could not be confirmed. Check Drive before retrying.” The retry succeeds and shows the confirmed Sheets link.

## markdown-table-export-023

Original test `A upload failure leaves the table save available for retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L752).

- **Given** A table is ready to save to Google Drive, but its initial file upload fails with a 503 response.
- **When** The user chooses Save to Google Drive, then retries after the failure.
- **Then** The first attempt displays “Could not upload the table. Please try again.” and leaves the save available. The retry succeeds with its returned link; the save action is recorded once per attempt.

## markdown-table-export-024

Original test `A Google Drive API failure leaves the table save available for retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L752).

- **Given** A table is ready to save to Google Sheets, but the initial Google Drive API request fails with a 503 response.
- **When** The user chooses Save to Google Sheets, then retries after the failure.
- **Then** The first attempt displays “Google Drive is temporarily unavailable” and leaves the save available. The retry succeeds with its returned link; the save action is recorded once per attempt.

## markdown-table-export-025

Original test `The table export trigger is disabled and named Saving… during the initial upload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L797).

- **Given** A chat contains two tables, and the first table’s upload is still in progress after the user requests a Google Drive save.
- **When** The upload remains pending, then completes successfully.
- **Then** The first table’s Export control is disabled, named “Saving…,” and marked busy while the upload is pending. The second table’s Export control remains enabled and named “Export”; after completion, the first control is no longer busy and a success notice shows the returned link.

## markdown-table-export-026

Original test `A completed original save without a URL remains available to save again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L831).

- **Given** A Google Drive save completes successfully but returns no URL.
- **When** The user saves the table to Google Drive again and the response includes a URL.
- **Then** The first attempt displays a success notice without a link. The save remains available, and the second success notice shows the returned URL.

## markdown-table-export-027

Original test `A completed google save without a URL remains available to save again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L831).

- **Given** A Google Sheets save completes successfully but returns no URL.
- **When** The user saves the table to Google Sheets again and the response includes a URL.
- **Then** The first attempt displays a success notice without a link. The save remains available, and the second success notice shows the returned URL.
