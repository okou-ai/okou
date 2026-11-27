package ai.okou.android.chat

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

@Serializable
enum class ConversationFollowupKind {
    @SerialName("talk") Talk,
    @SerialName("generate") Generate,
    @SerialName("workflow") Workflow,
    @SerialName("email") Email,
}

@Serializable
enum class FollowupGenerationType {
    @SerialName("image") Image,
    @SerialName("presentation") Presentation,
    @SerialName("website") Website,
    @SerialName("video") Video,
}

@Serializable
data class ConversationFollowup(
    val prompt: String,
    val kind: ConversationFollowupKind,
    val generationType: FollowupGenerationType? = null,
)

@Serializable
private data class FollowupDocument(val version: Int, val followups: List<ConversationFollowup>)

internal fun conversationFollowups(content: String?): List<ConversationFollowup> {
    if (content == null) return emptyList()
    val document =
        try {
            Json.decodeFromString<FollowupDocument>(content)
        } catch (_: SerializationException) {
            return emptyList()
        }
    if (document.version != 1) return emptyList()
    return document.followups
        .asSequence()
        .filter { it.prompt.isNotBlank() && it.generationType != FollowupGenerationType.Video }
        .take(3)
        .toList()
}

internal enum class ReplyPhase {
    Unknown,
    Continued,
    Replying,
    Completed,
    Failed,
    Stopped,
}

internal data class ReplySummary(
    val phase: ReplyPhase,
    val startedAtMillis: Long?,
    val endedAtMillis: Long?,
) {
    fun elapsedMillis(now: Long): Long? {
        val start = startedAtMillis ?: return null
        val end = endedAtMillis ?: now.takeIf { phase == ReplyPhase.Replying } ?: return null
        return (end - start).takeIf { it >= 0 }
    }
}

internal data class ConversationCompletion(
    val eventId: String,
    val anchorKey: String?,
    val finishedAtMillis: Long?,
    val followups: List<ConversationFollowup>,
) : ConversationTimelineRow {
    override val key = ConversationCompletionKey
}

internal const val ConversationCompletionKey = "conversation_completion"

internal data class ConversationTurns(
    val messages: List<ConversationMessage>,
    val completion: ConversationCompletion?,
)

internal fun HistoryMessage.hasReplyBody() = role == HistoryRole.Assistant && blocks.isNotEmpty()

internal fun HistoryMessage.isOutputReply() = status == null && hasReplyBody()

internal fun HistoryMessage.isTerminalStatus() =
    status == "run.completed" || status == "run.failed" || status == "run.cancelled"

private fun HistoryMessage.isFailureFeedback() = status == "run.failed" || status == "output.error"

/** A steer splits the display turn even though its input and replies use the same Run ID. */
internal fun conversationTurns(
    messages: List<HistoryMessage>,
    liveRunIds: Set<String>,
): ConversationTurns {
    val turns = mutableListOf<MutableList<HistoryMessage>>()
    for (message in messages) {
        val last = turns.lastOrNull()
        if (last != null && message.continuesDisplayTurn(last.first().runId)) {
            last.add(message)
        } else {
            turns.add(mutableListOf(message))
        }
    }

    var nextInput: HistoryMessage? = null
    var latestTurn = true
    var completion: ConversationCompletion? = null
    val reversedMessages = buildList {
        for (turn in turns.asReversed()) {
            val runId = turn.first().runId
            val input = turn.first().takeIf { it.isDeliveredInput() }
            val terminal = turn.lastOrNull { it.isTerminalStatus() }
            val failure = terminal?.takeIf { it.status == "run.failed" }
            val failureEvents = failure?.let { turn.filter { it.isFailureFeedback() } }.orEmpty()
            val replies = turn.filter { it.isOutputReply() }
            val latestReply = replies.lastOrNull()
            val feedbackHeader =
                if (latestReply == null && turn.none { it.hasReplyBody() }) {
                    turn.firstOrNull { it.isFailureFeedback() || it.status == "run.cancelled" }
                } else null
            val phase =
                when (terminal?.status) {
                    "run.completed" -> ReplyPhase.Completed
                    "run.failed" -> ReplyPhase.Failed
                    "run.cancelled" -> ReplyPhase.Stopped
                    else ->
                        when {
                            nextInput != null -> ReplyPhase.Continued
                            runId in liveRunIds -> ReplyPhase.Replying
                            else -> ReplyPhase.Unknown
                        }
                }
            val end = terminal?.occurredAtMillis
            val nextStart = nextInput?.occurredAtMillis
            val summary =
                ReplySummary(
                    phase,
                    // The delivered input timestamp excludes its time as a pending queue entry.
                    input?.occurredAtMillis,
                    when {
                        terminal == null -> nextStart
                        end == null -> null
                        nextStart == null -> end
                        else -> minOf(end, nextStart)
                    },
                )
            val firstRowOfTurn = size
            for (message in turn.asReversed()) {
                if (!message.visibleInConversation()) continue
                if (message === latestReply) {
                    add(
                        ConversationMessage(
                            message,
                            replies.dropLast(1),
                            summary = summary.takeIf { runId != null },
                        ),
                    )
                } else if (!message.isOutputReply()) {
                    val display =
                        if (failure != null && message.isFailureFeedback()) {
                            if (message !== failureEvents.first()) continue
                            failure
                        } else message
                    add(
                        ConversationMessage(
                            display,
                            showFeedbackHeader = message === feedbackHeader,
                            failureEventIds =
                                if (display === failure && failureEvents.size > 1)
                                    failureEvents.map { it.id }
                                else emptyList(),
                        ),
                    )
                }
            }
            if (latestTurn && (input != null || terminal != null || latestReply != null)) {
                if (terminal?.status == "run.completed") {
                    completion =
                        ConversationCompletion(
                            terminal.id,
                            getOrNull(firstRowOfTurn)?.key,
                            end,
                            turn.lastOrNull { it.followups != null }?.followups.orEmpty(),
                        )
                }
                latestTurn = false
            }
            if (input != null) nextInput = input
        }
    }
    return ConversationTurns(reversedMessages.asReversed(), completion)
}

internal data class WorkDuration(val hours: Long, val minutes: Long, val seconds: Long)

internal fun workDuration(elapsedMillis: Long): WorkDuration {
    val seconds = elapsedMillis / 1_000 + if (elapsedMillis % 1_000 >= 500) 1 else 0
    if (seconds < 3_600) return WorkDuration(0, seconds / 60, seconds % 60)
    val minutes = elapsedMillis / 60_000 + if (elapsedMillis % 60_000 >= 30_000) 1 else 0
    return WorkDuration(minutes / 60, minutes % 60, 0)
}
