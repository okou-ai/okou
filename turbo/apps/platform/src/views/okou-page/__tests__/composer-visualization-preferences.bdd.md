# Composer visualization preferences

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [composer-visualization-preferences.test.tsx](composer-visualization-preferences.test.tsx).

## composer-visualization-preferences-001

Original test `Chart choices produce one read-only summary with compact text and ordered full names`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.test.tsx#L167).

- **Given** The user has selected Chart in the composer and opens Visualization options.
- **When** They choose Spreadsheet and Bar chart, then toggle Spreadsheet off and select Bar chart, Sankey diagram, and Line chart in that order, removing Bar chart and Line chart afterward.
- **Then** The draft has one read-only summary: first “Spreadsheet · Bar,” then “Bar,” then “Bar, Sankey,” then compact “Bar +2,” and finally “Sankey, Line.” Removing the final chart removes the summary. The send control stays disabled, and activating the summary does not open a menu or dialog or change the selections.

## composer-visualization-preferences-002

Original test `Removing Chart and choosing another task remembers its choices for the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.test.tsx#L239).

- **Given** The user has entered a draft and selected Spreadsheet and Bar chart for Chart.
- **When** They remove Chart, choose Image, remove Image, and choose Chart again.
- **Then** The draft text remains, and the restored Chart options still have Spreadsheet and Bar chart selected with the same summary.

## composer-visualization-preferences-003

Original test `The first Chart send keeps pending choices and consumes them only on acceptance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.test.tsx#L277).

- **Given** The user has selected Spreadsheet and Bar chart for a new Chart draft.
- **When** They send the first prompt while acceptance is pending, then the send is accepted and they send another prompt without selecting a chart.
- **Then** While the first send is pending, the draft retains its choices and the sent message shows the Spreadsheet · Bar summary. On acceptance, the draft choices are consumed; the next message has no chart summary, and the first message’s summary remains unchanged.

## composer-visualization-preferences-004

Original test `A destination A-to-B-to-A Chart choice survives the first blocked send`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.test.tsx#L326).

- **Given** A first Chart send from the home composer is blocked pending acceptance, and its draft has Spreadsheet and Bar chart selected.
- **When** On the destination thread, the user enters a separate draft and changes choices from Website with Bar and Sankey selected back to Spreadsheet with Bar selected, then the first send completes.
- **Then** The destination draft text and Spreadsheet · Bar choices survive the earlier blocked send; the first sent message retains its Spreadsheet · Bar summary, and the destination remains the same thread.

## composer-visualization-preferences-005

Original test `A failed first Chart send keeps the destination's choices available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.test.tsx#L395).

- **Given** The user selects Spreadsheet and Bar chart for a Chart draft, and the first send is pending.
- **When** The send is rejected after it is unblocked.
- **Then** The destination draft retains its Spreadsheet · Bar summary and both choices remain selected; the user is on the destination thread.

## composer-visualization-preferences-006

Original test `Sending and queuing in an existing thread consume each draft without changing sent summaries`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.test.tsx#L424).

- **Given** The user is composing in an existing thread with no Chart choices selected.
- **When** They send a draft with Spreadsheet and Bar chart, then while that run is active select Website and Sankey diagram and send a queued draft.
- **Then** Each sent draft consumes its choices, and each message keeps its own summary: Spreadsheet · Bar for the first and Website · Sankey for the queued message. Reopened options are unselected, and the thread location does not change.

## composer-visualization-preferences-007

Original test `An A-to-B-to-A next-draft Chart choice survives an earlier blocked send`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.test.tsx#L464).

- **Given** In an existing thread, a first send with Spreadsheet and Bar chart is blocked, and the next draft retains its own choices.
- **When** The user changes the next draft from Website with Bar and Sankey selected back to Spreadsheet with Bar selected, then the first send is accepted.
- **Then** The next draft text and Spreadsheet · Bar choices survive; the first sent message keeps its Spreadsheet · Bar summary. The retained options show Spreadsheet and Bar selected and Sankey unselected.

## composer-visualization-preferences-008

Original test `A rejected Chart submission leaves the selected choices available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.test.tsx#L522).

- **Given** The user selects Spreadsheet and Bar chart for a Chart draft in an existing thread.
- **When** They submit the draft and the service rejects the message.
- **Then** The draft retains its Spreadsheet · Bar summary, with Spreadsheet and Bar chart still selected.
