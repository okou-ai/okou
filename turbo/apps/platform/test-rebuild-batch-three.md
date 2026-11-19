# App rebuild hosted sites and public artifacts

Main remained at `4bf10b89`. This batch has no upstream test additions
and none of its six paths intersects the 72 remaining mapping reviews.
The previous upstream additions remain outside frozen-case accounting.

| File                             | Frozen executions | Registered and passed |
| -------------------------------- | ----------------: | --------------------: |
| Hosted-site authorization        |                 6 |                     3 |
| Shared conversation presentation |                 6 |                     3 |
| Shared conversation attachments  |                 5 |                     3 |
| Anonymous shared artifact        |                 4 |                     2 |
| Artifact catalog JSON preview    |                 1 |                     1 |
| Artifact catalog pagination      |                 2 |                     1 |
| This round                       |                24 |                    13 |
| All verified files so far        |                73 |                    41 |

The [execution ledger](test-rebuild-rebuilt-executions.tsv) records exact
runtime registration names and frozen IDs. The focused Vitest JSON results
give the expanded counts. Static collection supplies registration lines.
Each file passed its focused run and Oxlint, then its adjacent temporary
BDD was removed. Cumulative confirmed net reduction is 32 frozen
executions across 15 files. The full suite still needs actual registered
count verification at the 30% gate.

## Coverage evidence

- The hosted-site bridge starts through the production Router. Its HTTP
  authorization response and the browser navigation are the boundaries
  under test. Denial and transient failure take different recovery
  destinations, and organization selection retains the original bridge
  URL. The recovery path with no valid return address remains an open
  selection question from the [first batch](test-rebuild-batch-one.md).
- The signed-out shared conversation renders assistant headings and
  emphasis, preserves literal user text and safe external links, and
  binds sign-in on a missing conversation to the original URL. Attachment
  links retain their original URLs and safe navigation semantics while
  image thumbnails request the intended dimensions.
- A public image retains its fragment and supports clipboard sharing and
  a native download. An unavailable image stays on the original route
  and offers sign-in only on the reader's action. The sign-in return URL
  is checked on the Clerk boundary.
- Catalog tests use the production file and image tabs. The JSON viewer
  preserves the original numeric spelling and full source. Closing an
  image preview opened from a deep link clears the selection and keeps
  the later-page image in its original catalog tab.

Next, continue with snapshot downloads and private artifacts embedded in
shared conversations. The mail retry template and invalid hosted return
address questions still await Ethan's review.
