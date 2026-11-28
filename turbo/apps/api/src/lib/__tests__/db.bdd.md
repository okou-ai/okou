# db

## db-001

- Vitest: "database pool lifecycle > gives one caller ownership when pool shutdown overlaps"
- Mode: run
- Intent: review
- Given: The API has a live database connection that has executed `SELECT 1`.
- When: Two shutdown callers request pool closure before the first close completes. A borrower then issues another `SELECT 1`.
- Then: Both close requests resolve with no value and the later query succeeds using a fresh pool.
