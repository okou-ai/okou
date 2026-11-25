# artifact-library

## artifact-library-001

- Vitest: "artifact library list queries > honors per-user opt-in and opt-out while legacy requests and cursors stay available"
- Mode: run
- Given: A signed-in member without artifact-library opt-in has uploaded first.txt and then second.txt.
- When: The member uses the legacy listing, requests explicit ascending ordering, opts in and requests ascending ordering again, then opts out and resumes the old cursor.
- Then: The first legacy page returns second.txt and a cursor. Library ordering is forbidden before opt-in and after opt-out. While opted in, ascending returns first.txt then second.txt. The legacy cursor still returns first.txt with no next cursor and searching uppercase SECOND matches the first legacy page.

## artifact-library-002

- Vitest: "artifact library list queries > orders the full filtered result by creation in either direction across every page"
- Mode: run
- Given: An opted-in member has four text files including repeated Echo titles and a separate Deck presentation.
- When: The member paginates the filtered file set by creation ascending and descending, then searches presentations using uppercase DECK.
- Then: Every descending file ID is in the legacy order, and the ascending order is the same set in reverse across all pages. The presentation search returns only Deck.pptx and no next cursor.

## artifact-library-003

- Vitest: "artifact library list queries > binds library cursors to direction, filters and the authorized owner without widening literal search"
- Mode: run
- Given: An opted-in owner with three artifacts including literal%_draft.txt obtains an ascending cursor after Alpha.txt.
- When: The owner reuses the cursor with changed order, kind, keyword or thread filter, and mixes malformed or incompatible legacy and library cursors. The owner also searches for percent and underscore. A same-workspace peer and the same owner in another workspace each try the original cursor after opting in.
- Then: Every mismatched, malformed or cross-identity cursor returns HTTP 403. Each literal search returns only the matching filename and no cursor. The other identities cannot use ordered listing before opt-in, and after opt-in a fresh list returns no artifacts or next cursor.
