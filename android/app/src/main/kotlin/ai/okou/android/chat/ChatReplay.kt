package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatArchiveChatThreadsItem
import ai.okou.android.api.generated.ChatArchiveChatThreadsItemModelSettingsValue
import ai.okou.android.api.generated.ChatArchiveChatThreadsItemModelSettingsValueEffort
import ai.okou.android.api.generated.ChatArchiveChatThreadsItemServiceTier
import ai.okou.android.api.generated.ChatEventsEventsItem
import ai.okou.android.api.generated.ChatEventsEventsItemVariant1
import ai.okou.android.api.generated.ChatEventsEventsItemVariant1Kind
import ai.okou.android.api.generated.ChatEventsEventsItemVariant2
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import kotlinx.serialization.Serializable

typealias ConfirmedChat = ChatArchiveChatThreadsItem

internal const val MAX_CHAT_THREADS = 10_000
internal const val MAX_CHAT_EVENTS = 10_000

internal fun requireChatWire(valid: Boolean) {
    if (!valid) throw ApiFailure.IncompatibleResponse()
}

@Serializable
data class ChatCursor(val eventId: String? = null, val seqId: Long = 0) {
    fun validate() {
        requireChatWire((eventId == null && seqId == 0L) || (eventId != null && seqId > 0))
        eventId?.let { requireChatId(it) }
    }
}

@Serializable
data class ChatCheckpoint(
    val archive: ChatArchive,
    val snapshotCursor: ChatCursor,
    val events: List<ChatEventsEventsItem>,
    val cursor: ChatCursor,
) {
    fun validate() {
        snapshotCursor.validate()
        cursor.validate()
        requireChatWire(
            archive.chatThreads.size <= MAX_CHAT_THREADS && events.size <= MAX_CHAT_EVENTS
        )
        val threads = HashSet<String>()
        archive.chatThreads.forEach { row ->
            requireChatId(row.id)
            requireChatId(row.agentId)
            row.projectId?.let(::requireChatId)
            requireChatWire(threads.add(row.id))
            chatTime(row.createdAt)
            chatTime(row.updatedAt)
            chatTime(row.sortAt)
            row.pinnedAt?.let(::chatTime)
        }
        var previous = snapshotCursor.seqId
        val identities = hashSetOf<String>().apply { snapshotCursor.eventId?.let(::add) }
        events.forEach { event ->
            val next = event.cursor()
            next.validate()
            requireChatId(event.threadId())
            when (event) {
                is ChatEventsEventsItemVariant1 -> {
                    requireChatId(event.agentId)
                    event.reassignedAgentId?.let(::requireChatId)
                    event.projectId?.let(::requireChatId)
                    chatTime(event.createdAt)
                }
                is ChatEventsEventsItemVariant2 -> {
                    requireChatId(event.agentId)
                    event.projectId?.let(::requireChatId)
                    chatTime(event.createdAt)
                }
            }
            requireChatWire(next.seqId > previous && identities.add(checkNotNull(next.eventId)))
            previous = next.seqId
        }
        requireChatWire(cursor == (events.lastOrNull()?.cursor() ?: snapshotCursor))
    }
}

private val chatIdPattern =
    Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

internal fun requireChatId(value: String) = requireChatWire(chatIdPattern.matches(value))

internal fun ChatEventsEventsItem.cursor(): ChatCursor =
    when (this) {
        is ChatEventsEventsItemVariant1 -> ChatCursor(id, seqId)
        is ChatEventsEventsItemVariant2 -> ChatCursor(id, seqId)
    }

private fun ChatEventsEventsItem.threadId(): String =
    when (this) {
        is ChatEventsEventsItemVariant1 -> chatThreadId
        is ChatEventsEventsItemVariant2 -> chatThreadId
    }

internal data class ChatTimestamp(val milliseconds: Long, val subMillisecond: String) :
    Comparable<ChatTimestamp> {
    override fun compareTo(other: ChatTimestamp): Int =
        milliseconds.compareTo(other.milliseconds).takeIf { it != 0 }
            ?: subMillisecond.compareTo(other.subMillisecond)
}

private val chatTimestampPattern =
    Regex("(\\d{4}-\\d{2}-\\d{2})[T ](\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d+))?(Z|[+-]\\d{2}:?\\d{2})?")

/** Only historical pin keys truncate to milliseconds, matching JS Date.parse. */
internal fun chatTime(value: String): Long = chatTimestamp(value).milliseconds

/** SQL times without a suffix are UTC; recency retains sub-millisecond precision. */
internal fun chatTimestamp(value: String): ChatTimestamp {
    val match = chatTimestampPattern.matchEntire(value) ?: throw ApiFailure.IncompatibleResponse()
    val fraction = match.groupValues[3].take(3).padEnd(3, '0')
    val zone =
        match.groupValues[4]
            .ifEmpty { "Z" }
            .let { if (it.length == 5) it.take(3) + ":" + it.takeLast(2) else it }
    val text = "${match.groupValues[1]}T${match.groupValues[2]}.$fraction$zone"
    val parser =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).apply {
            isLenient = false
            timeZone = TimeZone.getTimeZone("UTC")
        }
    val position = ParsePosition(0)
    val date = parser.parse(text, position)
    requireChatWire(date != null && position.index == text.length)
    return ChatTimestamp(checkNotNull(date).time, match.groupValues[3].drop(3).trimEnd('0'))
}

/** Full-tail replay preserves metadata updates that precede a thread's creation. */
fun replayChats(checkpoint: ChatCheckpoint): List<ConfirmedChat> {
    checkpoint.validate()
    val rows = checkpoint.archive.chatThreads.associateByTo(linkedMapOf()) { it.id }
    rows.replaceAll { _, row ->
        row.copy(
            serviceTier =
                row.serviceTier?.takeIf { it == ChatArchiveChatThreadsItemServiceTier.PRIORITY }
        )
    }
    val pending = mutableMapOf<String, MutableList<ChatEventsEventsItem>>()
    fun apply(event: ChatEventsEventsItem) {
        if (event is ChatEventsEventsItemVariant2) {
            val row = rows[event.chatThreadId]
            if (row == null) pending.getOrPut(event.chatThreadId) { mutableListOf() }.add(event)
            else
                rows[event.chatThreadId] =
                    row.copy(projectId = event.projectId, updatedAt = event.createdAt)
            return
        }
        event as ChatEventsEventsItemVariant1
        val kind = event.kind
        val id = event.chatThreadId
        if (kind == ChatEventsEventsItemVariant1Kind.CREATED) {
            rows[id] =
                ConfirmedChat(
                    id = id,
                    agentId = event.agentId,
                    projectId = event.projectId,
                    title = event.title,
                    createdAt = event.createdAt,
                    updatedAt = event.createdAt,
                    sortAt = event.createdAt,
                    pinnedAt = null,
                    archived = false,
                    renamedAt = null,
                    hidden = event.hidden ?: false,
                    muted = false,
                    selectedModel = event.selectedModel,
                    serviceTier =
                        event.serviceTier?.let { ChatArchiveChatThreadsItemServiceTier.PRIORITY },
                    computerUseHostId = event.computerUseHostId,
                    cloudBrowserEnabled = event.cloudBrowserEnabled ?: false,
                    modelSettings =
                        event.modelSettings?.mapValues { (_, setting) ->
                            ChatArchiveChatThreadsItemModelSettingsValue(
                                setting.effort?.let {
                                    ChatArchiveChatThreadsItemModelSettingsValueEffort.valueOf(
                                        it.name
                                    )
                                }
                            )
                        },
                )
            pending.remove(id)?.forEach { update ->
                val time =
                    when (update) {
                        is ChatEventsEventsItemVariant1 -> update.createdAt
                        is ChatEventsEventsItemVariant2 -> update.createdAt
                    }
                if (chatTimestamp(time) >= chatTimestamp(event.createdAt)) apply(update)
            }
            return
        }
        if (kind == ChatEventsEventsItemVariant1Kind.DELETED) {
            rows.remove(id)
            return
        }
        val row = rows[id]
        if (row == null) {
            if (
                kind in
                    setOf(
                        ChatEventsEventsItemVariant1Kind.MODEL_SELECTION_UPDATED,
                        ChatEventsEventsItemVariant1Kind.SERVICE_TIER_UPDATED,
                        ChatEventsEventsItemVariant1Kind.COMPUTER_USE_HOST_UPDATED,
                    )
            ) {
                pending.getOrPut(id) { mutableListOf() }.add(event)
            }
            return
        }
        if (kind == ChatEventsEventsItemVariant1Kind.SORT_TOUCHED) {
            rows[id] =
                when {
                    event.hidden != null -> row.copy(hidden = event.hidden)
                    event.muted != null -> row.copy(muted = event.muted)
                    event.pinOrder != null ->
                        row.copy(
                            agentId = event.reassignedAgentId ?: row.agentId,
                            pinOrder = if (row.pinnedAt != null) event.pinOrder else row.pinOrder,
                        )
                    else ->
                        row.copy(
                            agentId = event.reassignedAgentId ?: row.agentId,
                            sortAt =
                                if (chatTimestamp(event.createdAt) > chatTimestamp(row.sortAt))
                                    event.createdAt
                                else row.sortAt,
                        )
                }
            return
        }
        val updated =
            when (kind) {
                ChatEventsEventsItemVariant1Kind.RENAMED ->
                    row.copy(title = event.title, renamedAt = event.createdAt)
                ChatEventsEventsItemVariant1Kind.PINNED ->
                    row.copy(pinnedAt = event.createdAt, pinOrder = event.pinOrder)
                ChatEventsEventsItemVariant1Kind.UNPINNED ->
                    row.copy(pinnedAt = null, pinOrder = null)
                ChatEventsEventsItemVariant1Kind.ARCHIVED -> row.copy(archived = true)
                ChatEventsEventsItemVariant1Kind.UNARCHIVED -> row.copy(archived = false)
                ChatEventsEventsItemVariant1Kind.SERVICE_TIER_UPDATED ->
                    row.copy(
                        serviceTier =
                            event.serviceTier?.let {
                                ChatArchiveChatThreadsItemServiceTier.PRIORITY
                            }
                    )
                ChatEventsEventsItemVariant1Kind.COMPUTER_USE_HOST_UPDATED ->
                    row.copy(
                        computerUseHostId = event.computerUseHostId,
                        cloudBrowserEnabled = event.cloudBrowserEnabled ?: false,
                    )
                ChatEventsEventsItemVariant1Kind.MODEL_SELECTION_UPDATED -> {
                    val patch = event.modelSettingsPatch
                    row.copy(
                        selectedModel = event.selectedModel,
                        modelSettings =
                            if (patch == null) row.modelSettings
                            else
                                row.modelSettings.orEmpty() +
                                    (patch.model to
                                        ChatArchiveChatThreadsItemModelSettingsValue(
                                            ChatArchiveChatThreadsItemModelSettingsValueEffort
                                                .valueOf(patch.effort.name)
                                        )),
                    )
                }
            }
        rows[id] = updated.copy(updatedAt = event.createdAt)
    }
    checkpoint.events.forEach(::apply)
    requireChatWire(rows.size <= MAX_CHAT_THREADS)
    val ranks =
        rows.values
            .filter { it.pinnedAt != null }
            .associate { row ->
                val reversed = 8_640_000_000_000_000L - chatTime(checkNotNull(row.pinnedAt))
                row.id to (row.pinOrder ?: "a0${reversed.toString().padStart(17, '0')}1")
            }
    val times = rows.values.associate { it.id to chatTimestamp(it.sortAt) }
    return rows.values.sortedWith { left, right ->
        when {
            (left.pinnedAt != null) != (right.pinnedAt != null) ->
                if (left.pinnedAt != null) -1 else 1
            left.pinnedAt != null && ranks[left.id] != ranks[right.id] ->
                checkNotNull(ranks[left.id]).compareTo(checkNotNull(ranks[right.id]))
            left.pinnedAt == null && times[left.id] != times[right.id] ->
                checkNotNull(times[right.id]).compareTo(checkNotNull(times[left.id]))
            else -> right.id.compareTo(left.id)
        }
    }
}
