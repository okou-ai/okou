# Workspace and sidebar rebuild

The batch uses the production Router with local Clerk, HTTP, realtime and
browser fixtures. The execution and GWT ledgers record the accepted expansion
of each selected scenario.

## Deferred files

The first local diagnostic run passed 39 of the 52 selected rows in these
four files. Their BDD and the original selection remain in the repository.
The diagnostic passes are excluded from the acceptance ledger.

| Selected IDs                                      | Given and When                                                                                                               | Expected Then and observed result                                                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org-members-tab-006`                             | Active limited-free-1 plan. The administrator submits an invitation without package controls.                                | The invitee should appear in People. The candidate timed out at 5 s before the complete result was observed. On retry, instrument the invitation response and the list refresh separately.                              |
| `sidebar-chat-history-005`                        | Release plan is active and Incident notes is listed. The user confirms deletion of Incident notes.                           | The toast and sidebar removal should appear while Release plan stays open. The candidate timed out at 5 s. On retry, observe the delete request, response and resulting row removal separately.                         |
| `project-chat-list-011`                           | An ordinary chat is active and the Launch Project is collapsed. The user clicks the Launch title to expand then collapse it. | Launch planning should appear, then fold without navigation. The first post-click assertion still saw `aria-expanded="false"`. Verify the title's asynchronous commit before interpreting this as a product difference. |
| `sidebar-virtualization-003`                      | Scrolled virtual list with Project 17 and its two conversations. Expand, collapse and reopen the Project.                    | History 1 should be reachable after reopening. The candidate timed out at 5 s.                                                                                                                                          |
| `sidebar-virtualization-004`, `018`, `020`, `022` | Expand a desktop, 10,000-chat, desktop external-footer or mobile unread-footer Project respectively.                         | Each should expand before checking the reveal height, row budget or footer. The first transition assertion still saw `aria-expanded="false"`.                                                                           |
| `sidebar-virtualization-006`, `023`               | Start folding before reversing, or collapse at the bottom of the virtual list.                                               | Folding should start or commit at the respective observable boundary. The fixture still saw `aria-expanded="true"` when it expected false.                                                                              |
| `sidebar-virtualization-008`                      | Advance an in-progress fold and reverse it.                                                                                  | Reversal should start from the displayed height. The fixture still saw `prepared` when it expected `running`.                                                                                                           |
| `sidebar-virtualization-011`, `019`               | Start a mobile reveal then interrupt it by touch or by routing to a chat.                                                    | The child block should exist before the interruption. It was absent when first queried.                                                                                                                                 |

The Project results establish where the candidate stopped. The next attempt
should synchronize the named row's committed expansion before advancing the
existing animation-frame fixture, while retaining the pre-frame and running
phase assertions.

## Accepted files

The workspace entry and sidebar controls batch accepted 36 of 68 frozen rows
across ten files. The navigation and shortcuts batch accepted 37 of 69 frozen
rows across ten files. Both batches passed targeted Vitest, Platform test
TypeScript, ESLint and both Oxlint configurations before BDD removal.

`project-order-003` mentions ArrowUp in When and ArrowDown in Then for the open
menu. The retained row checks both keys with the menu open and asserts the
Project order after each key.
