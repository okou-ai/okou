# For you custom target selection

[#49274](https://github.com/okou-ai/okou/pull/49274) assigns a custom
direction's destination through the card's custom option. The related-chat
chooser and Back control retired, including previously unselected 1312-01.
Previously accepted 1244-01 now checks the named target and preserved draft.

| Upstream ID suffix | Decision            | Reason                                                                                                                                        |
| ------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1311-01            | Retain and verified | A cache miss must still send to the named existing chat.                                                                                      |
| 1364-01            | Unselected          | The custom option has no destination, so it follows the existing new-chat path. Another option's destination belongs to that separate action. |
| 1401-01            | Retain and verified | A canonical missing-target response must recover by creating a chat and sending the direction there.                                          |

The 19 expanded For you rows include exactly two new upstream executions.
The two MCP table rows match the two selected frozen IDs and verify both UI
feedback and the absence of exception reports at the Sentry SDK boundary.
