# Connectors category filter

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-category-filter.test.tsx](connectors-category-filter.test.tsx).

## connectors-category-filter-001

Original test `Offer every whole-catalog category id, named from the id alone`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-category-filter.test.tsx#L19).

- **Given** The whole-catalog category totals include Communication (12), Documents (40), Meetings (0), and an uncategorized-in-the-UI future category (3).
- **When** The user opens the category filter.
- **Then** The options are All, Communication12, Documents40, and Future Category3, ordered by name; the zero-count Meetings category is omitted and the future category name is derived from its ID.
