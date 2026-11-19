# Browser input dialog updates in 9e40c6e3

Compared `6c2ec0a0` with [9e40c6e3 (#49272)](https://github.com/okou-ai/okou/pull/49272).
The redesigned Browser input dialog and its copy change are integrated.
The two incoming test paths stay cleared on this branch, and their frozen
BDD files remain the rebuild source. No frozen or upstream counts change.

| Path                                                              | Registration titles | Rebuild note                                                                                         |
| ----------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `browser-user-action/__tests__/browser-user-action-page.test.tsx` | Unchanged           | Use the current saved-password help label, “Use a saved password”.                                   |
| `okou-page/__tests__/chat-capability-browser-actions.test.tsx`    | Unchanged           | Query inline dialog fields through their current accessible labels and the redesigned dialog layout. |

Both rows await rebuild with their files. They add no new scenarios.
