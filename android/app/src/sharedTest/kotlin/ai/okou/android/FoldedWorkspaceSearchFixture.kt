package ai.okou.android

import kotlinx.serialization.json.JsonPrimitive

internal class FoldedWorkspaceSearchFixture(chats: ChatListApiFixture) {
    val keyword = "截止时间"
    val hit = "把发布清单中的截止时间更新到周五。"
    val otherEarlierReply = "先核对访谈记录与会议附件。"
    val otherFinalReply = "访谈纪要已整理。"
    val matchedFinalId = "launch-final"
    val otherFinalId = "interview-final"

    init {
        val otherRun = "a9999999-9999-4999-8999-999999999999"
        val lastEvent = "a8888888-8888-4888-8888-888888888888"
        val rows =
            listOf(
                17L to prompt("launch-input", 17, HISTORY_RUN, "核对发布计划"),
                22L to reply("launch-earlier", 22, HISTORY_RUN, hit),
                23L to reply(matchedFinalId, 23, HISTORY_RUN, "第一轮检查已完成。"),
                37L to
                    historyEventWire(
                        HISTORY_LAST_EVENT,
                        37,
                        type = "run.completed",
                        payload = "null",
                    ),
                40L to prompt("interview-input", 40, otherRun, "整理客户访谈"),
                41L to reply("interview-earlier", 41, otherRun, otherEarlierReply),
                42L to reply(otherFinalId, 42, otherRun, otherFinalReply),
                50L to
                    historyEventWire(
                        lastEvent,
                        50,
                        type = "run.completed",
                        payload = "null",
                        run = otherRun,
                    ),
            )
        chats.historyRows = { request ->
            val after = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0L
            val tail =
                rows.filter { (sequence, _) -> sequence > after }.joinToString(",") { it.second }
            jsonResponse(
                """{"rows":[$tail],"cursor":{"lastEventId":"$lastEvent","lastSeqId":50},"hasMore":false}""",
            )
        }
        chats.historyCatchUp = { jsonResponse("""{"events":{},"notFoundThreads":[]}""") }
        chats.searchMessages = { request ->
            if (request.requestUrl?.queryParameter("keyword") == keyword) {
                val start = hit.indexOf(keyword)
                jsonResponse(
                    """
                    {"results":[{"chatThreadId":"$CHAT_PERSONAL","agentName":"Okou",
                      "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                        "content":${JsonPrimitive(hit)},"createdAt":"$CHAT_DATE","seqId":22,"runId":"$HISTORY_RUN"},
                      "matchedRanges":[{"start":$start,"end":${start + keyword.length}}]}]}
                    """
                        .trimIndent(),
                )
            } else {
                jsonResponse("""{"results":[]}""")
            }
        }
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
