package ai.okou.android

import kotlinx.serialization.json.JsonPrimitive

internal class FoldedWorkspaceSearchFixture(chats: ChatListApiFixture) {
    val keyword = "截止时间"
    val hit = "把发布清单中的截止时间更新到周五。"
    val leadingParagraph = "已逐项和负责人核对发布清单。"
    val otherHit = "等确认截止时间后，再通知项目成员。"
    val otherEarlierReply = "先核对访谈记录与会议附件。"
    val otherFinalReply = "访谈纪要已整理。"
    val matchedFinalId = "launch-final"
    val otherFinalId = "interview-final"

    init {
        val hitSequence = 22L
        val otherHitSequence = 23L
        val otherRun = "a9999999-9999-4999-8999-999999999999"
        val lastEvent = "a8888888-8888-4888-8888-888888888888"
        val linkedLead = leadingParagraph.replace("发布清单", "[发布清单](https://example.org/$keyword)")
        val indexedBody = "$linkedLead\n\n${hit.replace(keyword, "**$keyword**")}"
        chats.setHistoryEvents(
            CHAT_PERSONAL,
            listOf(
                prompt("launch-input", 17, HISTORY_RUN, "核对发布计划"),
                reply("launch-review", 20, HISTORY_RUN, "已读取发布清单，正在核对负责人。"),
                reply("launch-hit", hitSequence, HISTORY_RUN, "\n\n$indexedBody"),
                reply("launch-other-hit", otherHitSequence, HISTORY_RUN, otherHit),
                reply(matchedFinalId, 24, HISTORY_RUN, "第一轮检查已完成。"),
                historyEventWire(HISTORY_LAST_EVENT, 37, type = "run.completed", payload = "null"),
                prompt("interview-input", 40, otherRun, "整理客户访谈"),
                reply("interview-earlier", 41, otherRun, otherEarlierReply),
                reply(otherFinalId, 42, otherRun, otherFinalReply),
                historyEventWire(
                    lastEvent,
                    50,
                    type = "run.completed",
                    payload = "null",
                    run = otherRun,
                ),
            ),
        )
        val matches =
            listOf(searchResult(otherHit, otherHitSequence), searchResult(indexedBody, hitSequence))
                .joinToString(",")
        chats.searchMessages = { request ->
            if (request.requestUrl?.queryParameter("keyword") == keyword) {
                jsonResponse("""{"results":[$matches]}""")
            } else {
                jsonResponse("""{"results":[]}""")
            }
        }
    }

    private fun searchResult(text: String, sequence: Long): String {
        val ranges =
            Regex.fromLiteral(keyword).findAll(text).joinToString(",") {
                """{"start":${it.range.first},"end":${it.range.last + 1}}"""
            }
        return """
            {"chatThreadId":"$CHAT_PERSONAL",
              "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                "content":${JsonPrimitive(text)},"createdAt":"$CHAT_DATE","seqId":$sequence,"runId":"$HISTORY_RUN"},
              "matchedRanges":[$ranges]}
            """
            .trimIndent()
    }

    private fun prompt(id: String, sequence: Long, run: String, text: String) =
        historyEventWire(
            id,
            sequence,
            type = "input.prompt",
            payload =
                """{"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(text)}}]}}""",
            run = run,
        )

    private fun reply(id: String, sequence: Long, run: String, text: String) =
        historyEventWire(
            id,
            sequence,
            payload = """{"content":${JsonPrimitive(text)}}""",
            run = run,
        )
}
