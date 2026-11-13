package ai.okou.android.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class HistoryProjectionContractTest {
    @Test
    fun everyHistoryPrefixConformsToTheActualWebSemantics() {
        val fixture =
            Json.parseToJsonElement(
                    checkNotNull(javaClass.getResource("/api-bindings/chat-history-semantics.json"))
                        .readText()
                )
                .jsonObject
        val threadId = fixture.getValue("threadId").jsonPrimitive.content
        for (history in fixture.getValue("histories").jsonArray.map { it.jsonObject }) {
            val rows = history.getValue("rows").jsonArray.map { HistoryEvent.decode(it.jsonObject) }
            for (checkpoint in history.getValue("checkpoints").jsonArray.map { it.jsonObject }) {
                val length = checkpoint.getValue("length").jsonPrimitive.int
                val prefix = rows.take(length)
                val byId = prefix.associateBy { it.id }
                val cursor =
                    prefix.lastOrNull()?.let { HistoryCursor(it.id, it.seqId) } ?: HistoryCursor()
                val actual = projectHistory(HistoryCheckpoint(threadId, prefix, cursor))
                val expected = checkpoint.getValue("expected").jsonObject
                val label = "${history.getValue("name").jsonPrimitive.content} at prefix $length"
                // Opaque usage remains inspectable in native UI; Web excludes it from groups.
                val events =
                    actual.messages
                        .filter { byId.getValue(it.id).type != "usage.recorded" }
                        .map { message ->
                            val type = message.status ?: byId.getValue(message.id).type
                            JsonObject(
                                mapOf(
                                    "id" to JsonPrimitive(message.id),
                                    "type" to JsonPrimitive(type),
                                    "queued" to JsonPrimitive(message.queued),
                                )
                            )
                        }
                assertEquals(label, expected.getValue("events"), JsonArray(events))
                assertEquals(
                    label,
                    expected.getValue("execution").jsonPrimitive.content,
                    actual.execution.name.lowercase(),
                )
                assertEquals(
                    label,
                    expected.getValue("workSteps").jsonPrimitive.int,
                    actual.workSteps,
                )
            }
        }
    }
}
