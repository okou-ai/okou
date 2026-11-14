package ai.okou.android.chat

import ai.okou.android.api.generated.RawHistoryRow
import java.io.InputStream
import java.io.InputStreamReader
import java.nio.charset.CodingErrorAction
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

internal val historyJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = true
    encodeDefaults = false
}

/** Canonical validation owns wire types; this domain envelope retains every original JSON value. */
class HistoryEvent private constructor(val wire: JsonObject) {
    override fun equals(other: Any?) = other is HistoryEvent && wire == other.wire

    override fun hashCode() = wire.hashCode()

    val id: String
        get() = wire.getValue("id").jsonPrimitive.content

    val threadId: String
        get() = wire.getValue("chatThreadId").jsonPrimitive.content

    val seqId: Long
        get() = wire.getValue("seqId").jsonPrimitive.long

    val type: String
        get() = wire.getValue("eventType").jsonPrimitive.content

    val runId: String?
        get() = wire["runId"]?.jsonPrimitive?.contentOrNull

    val revokesId: String?
        get() = wire["revokesEventId"]?.jsonPrimitive?.contentOrNull

    val payload: JsonObject?
        get() = wire["payload"]?.takeUnless { it === JsonNull }?.jsonObject

    val terminal: Boolean
        get() = type in setOf("run.completed", "run.failed", "run.cancelled")

    companion object {
        fun decode(wire: JsonObject): HistoryEvent {
            historyJson.decodeFromJsonElement<RawHistoryRow>(wire)
            return HistoryEvent(wire)
        }

        fun decode(text: String): HistoryEvent =
            decode(historyJson.parseToJsonElement(text).jsonObject)
    }
}

data class HistoryCursor(val eventId: String? = null, val seqId: Long = 0) {
    fun validate() =
        requireChatWire((eventId == null && seqId == 0L) || (eventId != null && seqId > 0))
}

data class HistoryCheckpoint(
    val threadId: String,
    val rows: List<HistoryEvent>,
    val cursor: HistoryCursor,
    val replaced: Boolean = false,
) {
    fun validate() {
        cursor.validate()
        var previous = 0L
        val ids = hashSetOf<String>()
        for (row in rows) {
            requireChatWire(row.threadId == threadId && row.seqId > previous && ids.add(row.id))
            previous = row.seqId
        }
        requireChatWire(
            cursor == (rows.lastOrNull()?.let { HistoryCursor(it.id, it.seqId) } ?: HistoryCursor())
        )
    }
}

/** A line is the parser's unit, never the entire archive. No native-only row/byte limit. */
internal fun readHistoryNdjson(input: InputStream): List<HistoryEvent> {
    val decoder =
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
    val reader = InputStreamReader(input, decoder)
    val buffer = CharArray(8192)
    val line = StringBuilder()
    val rows = mutableListOf<HistoryEvent>()
    while (true) {
        val count = reader.read(buffer)
        if (count < 0) break
        var start = 0
        for (index in 0 until count) {
            if (buffer[index] == '\n') {
                line.append(buffer, start, index - start)
                rows.add(HistoryEvent.decode(line.toString()))
                line.setLength(0)
                start = index + 1
            }
        }
        line.append(buffer, start, count - start)
    }
    requireChatWire(line.isEmpty())
    return rows
}
