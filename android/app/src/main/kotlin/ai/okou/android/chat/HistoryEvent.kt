package ai.okou.android.chat

import java.io.InputStream
import java.io.InputStreamReader
import java.nio.charset.CodingErrorAction
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal val historyJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = true
    encodeDefaults = false
}

@Serializable
private enum class HistoryEventType {
    @SerialName("input.prompt") InputPrompt,
    @SerialName("input.automation") InputAutomation,
    @SerialName("input.budget") InputBudget,
    @SerialName("input.rejected") InputRejected,
    @SerialName("output.message") OutputMessage,
    @SerialName("output.error") OutputError,
    @SerialName("output.followups") OutputFollowups,
    @SerialName("run.completed") RunCompleted,
    @SerialName("run.failed") RunFailed,
    @SerialName("run.cancelled") RunCancelled,
    @SerialName("control.interrupt") ControlInterrupt,
    @SerialName("control.revoke") ControlRevoke,
    @SerialName("usage.recorded") UsageRecorded,
}

@Serializable
private data class HistoryEventFacts(
    val id: String,
    val chatThreadId: String,
    val seqId: Long,
    val eventType: HistoryEventType,
    val runId: String?,
    val revokesEventId: String?,
)

@Serializable private data class HistoryContent(val content: String? = null)

@Serializable private data class HistoryError(val error: String? = null)

@Serializable private data class HistoryRunFailure(val failureReason: String? = null)

/** Read facts and payloads have their own models; raw JSON belongs to the cache. */
class HistoryEvent
private constructor(
    private val wire: JsonObject,
    private val facts: HistoryEventFacts,
    val content: String?,
    val userMessage: JsonElement?,
    val inputError: String?,
    val outputError: String?,
    val failureReason: String?,
) {
    override fun equals(other: Any?) = other is HistoryEvent && wire == other.wire

    override fun hashCode() = wire.hashCode()

    val id: String
        get() = facts.id

    val threadId: String
        get() = facts.chatThreadId

    val seqId: Long
        get() = facts.seqId

    val type: String
        get() = wire.getValue("eventType").jsonPrimitive.content

    val runId: String?
        get() = facts.runId

    val revokesId: String?
        get() = facts.revokesEventId

    /** Raw cache input is retained separately from business fields. */
    internal fun archiveJson(): String = wire.toString()

    val terminal: Boolean
        get() = type in setOf("run.completed", "run.failed", "run.cancelled")

    companion object {
        fun decode(wire: JsonObject): HistoryEvent {
            val facts = historyJson.decodeFromJsonElement<HistoryEventFacts>(wire)
            val payload =
                when (facts.eventType) {
                    HistoryEventType.InputPrompt,
                    HistoryEventType.InputAutomation,
                    HistoryEventType.InputBudget,
                    HistoryEventType.InputRejected,
                    HistoryEventType.OutputMessage,
                    HistoryEventType.OutputError,
                    HistoryEventType.OutputFollowups,
                    HistoryEventType.RunCompleted ->
                        wire["payload"]?.takeUnless { it === JsonNull }?.jsonObject
                    else -> null
                }
            val content =
                when (facts.eventType) {
                    HistoryEventType.OutputMessage,
                    HistoryEventType.OutputError,
                    HistoryEventType.OutputFollowups,
                    HistoryEventType.RunCompleted ->
                        payload?.let {
                            historyJson.decodeFromJsonElement<HistoryContent>(it).content
                        }
                    else -> null
                }
            val userMessage =
                when (facts.eventType) {
                    HistoryEventType.InputPrompt,
                    HistoryEventType.InputAutomation,
                    HistoryEventType.InputBudget,
                    HistoryEventType.InputRejected -> payload?.get("userMessage")
                    else -> null
                }
            val error =
                when (facts.eventType) {
                    HistoryEventType.InputRejected,
                    HistoryEventType.OutputError ->
                        payload?.let { historyJson.decodeFromJsonElement<HistoryError>(it).error }
                    else -> null
                }
            return HistoryEvent(
                wire,
                facts,
                content,
                userMessage,
                if (facts.eventType == HistoryEventType.InputRejected) error else null,
                if (facts.eventType == HistoryEventType.OutputError) error else null,
                if (facts.eventType == HistoryEventType.RunFailed)
                    historyJson.decodeFromJsonElement<HistoryRunFailure>(wire).failureReason
                else null,
            )
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
