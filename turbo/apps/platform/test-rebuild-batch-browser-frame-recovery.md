# Browser frame and recovery rebuild

| File                          | Frozen rows | Accepted IDs (numeric suffixes)             |
| ----------------------------- | ----------: | ------------------------------------------- |
| browser-frame-rate            |          11 | 001, 002, 003, 004, 010, 011                |
| browser-display-regression    |          16 | 001, 004, 005, 006, 007, 013, 015, 016      |
| browser-frames-recovery       |          16 | 001, 002, 004, 006, 007, 009, 013, 016      |
| browser-page-crash            |          15 | 001, 003, 005, 006, 010, 012, 013, 015      |
| browser-domain-initialization |          18 | 001, 003, 005, 007, 009, 011, 013, 014, 018 |

The five files enter through the production Router and use local HTTP and CDP
fixtures. The rebuild reuses the frozen test bodies for the selected scenarios
and removes parameter branches for unselected scenarios. FPS uses the injected
clock and completed paints. Display restoration and split image recovery hold
frames and native receipts independently. Page crash and domain initialization
release delayed replies after the user changes the relevant viewer state.

The GWT checklist records the original conditions, actions, and outcomes.
The execution ledger maps each accepted ID to a passing Vitest registration,
including both expanded crash notification variants. There are 39 accepted
registrations across 76 frozen rows.

Main `d97fcb02` changed only a Runner network test. The original
`browser-session-page` blockers 024, 025, and 034 retain their BDD and
previously recorded evidence.
