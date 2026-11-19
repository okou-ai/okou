# Activity network filter

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [activity-network-filter.test.tsx](activity-network-filter.test.tsx).

## activity-network-filter-001

Original test `Network type selections keep the menu open and reset the last deselection to all types`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-network-filter.test.tsx#L128).

- **Given** The activity’s Network tab contains HTTP, DNS, and TCP requests, and the type filter initially selects HTTP.
- **When** The user opens the filter and successively selects DNS, deselects HTTP, deselects DNS, selects TCP, and chooses All types twice.
- **Then** The menu stays open throughout. Selecting DNS adds it; deselecting HTTP leaves DNS; deselecting the last selected type restores all types. Selecting TCP then leaves HTTP and DNS selected, while All types restores all three and remains stable when selected again.

## activity-network-filter-002

Original test `Enter and Space each toggle a network type once, and Escape restores trigger focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-network-filter.test.tsx#L166).

- **Given** The Network tab contains HTTP, DNS, and TCP requests, with HTTP selected by default.
- **When** The user opens the type filter with Enter, navigates to DNS, toggles it with Enter and Space, then presses Escape.
- **Then** Enter adds DNS once and Space removes it once, with focus staying on DNS and the selected-type label updating. Escape closes the menu and restores focus to the filter trigger.
