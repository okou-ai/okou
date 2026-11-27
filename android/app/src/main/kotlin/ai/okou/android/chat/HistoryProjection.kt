package ai.okou.android.chat

import ai.okou.android.api.generated.KnownRunFailureReason
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

enum class HistoryRole {
    User,
    Assistant,
    System,
}

enum class HistoryBlockKind {
    Text,
    Reference,
    Attachment,
    Unsupported,
    Error,
}

enum class HistoryExecution {
    Idle,
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

data class HistoryBlock(
    val kind: HistoryBlockKind,
    val text: String,
    val title: String? = null,
    val attachment: ChatAttachmentReference? = null,
)

internal fun ChatAttachmentReference.historyBlock() =
    HistoryBlock(HistoryBlockKind.Attachment, "", filename, this)

data class HistoryMessage(
    val id: String,
    val runId: String?,
    val role: HistoryRole,
    val blocks: List<HistoryBlock>,
    val queued: Boolean = false,
    val rejected: Boolean = false,
    val status: String? = null,
    val failureReason: String? = null,
    val queueSequence: Long? = null,
    val queuedWorkflow: QueuedWorkflow? = null,
    val sourceSeqId: Long? = null,
    val occurredAtMillis: Long? = null,
    val followups: List<ConversationFollowup>? = null,
)

data class QueuedWorkflow(val name: String?, val triggerBrief: String?)

internal fun HistoryMessage.isDeliveredInput() =
    role == HistoryRole.User && runId != null && !rejected

internal fun HistoryMessage.continuesDisplayTurn(previousRunId: String?) =
    runId != null && runId == previousRunId && !isDeliveredInput()

internal fun HistoryMessage.hasReplyBody() =
    role == HistoryRole.Assistant &&
        blocks.any { it.kind != HistoryBlockKind.Text || it.text.isNotBlank() }

internal fun HistoryMessage.visibleInConversation() =
    when (status) {
        null,
        "run.completed" ->
            queued ||
                rejected ||
                if (role == HistoryRole.Assistant) hasReplyBody() else blocks.isNotEmpty()
        else -> true
    }

@ConsistentCopyVisibility
data class HistoryTranscript
internal constructor(
    val messages: List<HistoryMessage>,
    val execution: HistoryExecution,
    val workSteps: Int,
    val activeRunId: String? = null,
    val persistedIds: Set<String> = emptySet(),
    val liveRunIds: List<String> = listOfNotNull(activeRunId),
    val terminatedRunIds: Set<String> = emptySet(),
    val pendingInputIds: Set<String> = emptySet(),
    val revocableInputIds: Set<String> = emptySet(),
    internal val resources: ChatResourceReferences? = null,
) {
    internal fun searchMessage(sequence: Long): HistoryMessage? = messages.firstOrNull {
        it.sourceSeqId == sequence && it.visibleInConversation() && it.id !in pendingInputIds
    }
}

internal fun HistoryTranscript.hasSettledInput(eventId: String) =
    eventId in persistedIds && eventId !in pendingInputIds

internal fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull

internal data class HistoryControlFacts(
    val rows: List<HistoryEvent>,
    val liveRunIds: List<String>,
    val terminatedRunIds: Set<String>,
    val pendingInputIds: Set<String>,
    val revocableInputIds: Set<String>,
)

/** Control readback uses event identities without re-decoding user documents on Main. */
internal fun historyControlFacts(checkpoint: HistoryCheckpoint): HistoryControlFacts {
    val revoked = checkpoint.rows.mapNotNullTo(hashSetOf()) { it.revokesId }
    val rows = checkpoint.rows.filter { it.id !in revoked }
    val pending = rows.filter {
        it.runId == null && (it.type == "input.prompt" || it.type == "input.automation")
    }
    // The recall endpoint requires an original queue entry.
    val revocable = pending.filter { it.revokesId == null }
    val ended =
        checkpoint.rows
            .filter { it.terminal || it.type == "control.interrupt" }
            .mapNotNullTo(hashSetOf()) { it.runId }
    return HistoryControlFacts(
        rows,
        rows
            .asSequence()
            .filterNot { it.type == "usage.recorded" || it.type == "control.interrupt" }
            .mapNotNull { it.runId }
            .filterNot { it in ended }
            .distinct()
            .toList(),
        ended,
        pending.mapTo(mutableSetOf()) { it.id },
        revocable.mapTo(mutableSetOf()) { it.id },
    )
}

/** Project confirmed event facts, without reinterpreting unknown JSON as a text-only bubble. */
fun projectHistory(checkpoint: HistoryCheckpoint): HistoryTranscript {
    checkpoint.validate()
    val controls = historyControlFacts(checkpoint)
    val automationInputs =
        checkpoint.rows.filter { it.type == "input.automation" }.mapTo(hashSetOf()) { it.id }
    val rows = controls.rows
    val terminals = rows.filter { it.terminal }.mapNotNullTo(hashSetOf()) { it.runId }
    val interrupted =
        rows.filter { it.type == "control.interrupt" }.mapNotNullTo(hashSetOf()) { it.runId }
    val pending = controls.pendingInputIds
    // Manual prompts remain in the transcript; only automation occupies Web's queued groups.
    val queued = pending.intersect(automationInputs)
    // Match Web's transcript visibility without discarding the underlying confirmed rows.
    val visible = rows.filterNot {
        it.type == "control.revoke" ||
            it.type == "input.budget" ||
            it.type == "usage.recorded" ||
            (it.type == "run.cancelled" && it.runId in interrupted) ||
            (it.type == "input.rejected" && it.revokesId in automationInputs)
    }
    // Like Web, place an older run's late event with its run; queued inputs come last.
    val turns = linkedMapOf<String, MutableList<HistoryEvent>>()
    for (row in visible) turns
        .getOrPut(
            if (row.id in queued) "queued:${row.id}"
            else row.runId?.let { "run:$it" } ?: "event:${row.id}",
        ) {
            mutableListOf()
        }
        .add(row)
    val ordered =
        turns.values.filter { it.none { row -> row.id in queued } }.flatten() +
            visible.filter { it.id in queued }
    val messages = ordered.mapNotNull { row ->
        val blocks = mutableListOf<HistoryBlock>()
        val legacyReason =
            if (row.type == "output.error") row.outputError?.let(::legacyFailureReason) else null
        val role =
            when (row.type) {
                "input.prompt",
                "input.rejected",
                "input.automation" -> {
                    val document = row.userMessage
                    if (
                        row.type == "input.automation" &&
                            (document == null || document === JsonNull)
                    ) {
                        if (row.id !in queued) return@mapNotNull null
                    } else {
                        blocks.addAll(userBlocks(document))
                    }
                    row.inputError?.let { blocks.add(HistoryBlock(HistoryBlockKind.Error, it)) }
                    HistoryRole.User
                }
                "output.message" -> {
                    row.content?.let { blocks.add(HistoryBlock(HistoryBlockKind.Text, it)) }
                        ?: blocks.add(
                            HistoryBlock(HistoryBlockKind.Unsupported, row.archiveJson()),
                        )
                    HistoryRole.Assistant
                }
                "run.failed" -> HistoryRole.System
                "output.error" -> {
                    if (legacyReason != KnownRunFailureReason.SAFETY_POLICY_REFUSAL) {
                        row.content
                            ?.takeIf { it.isNotBlank() }
                            ?.let {
                                blocks.add(HistoryBlock(HistoryBlockKind.Text, it))
                            }
                    }
                    if (legacyReason == null)
                        row.outputError?.let {
                            blocks.add(HistoryBlock(HistoryBlockKind.Error, it))
                        }
                    HistoryRole.System
                }
                "run.cancelled",
                "control.interrupt" -> {
                    if (row.type == "control.interrupt" && row.runId == null) return@mapNotNull null
                    HistoryRole.Assistant
                }
                "run.completed" -> {
                    row.content?.let { blocks.add(HistoryBlock(HistoryBlockKind.Text, it)) }
                    HistoryRole.Assistant
                }
                "output.followups" -> {
                    if (row.content == null) return@mapNotNull null
                    HistoryRole.System
                }
                else -> return@mapNotNull null
            }
        HistoryMessage(
            row.id,
            row.runId,
            role,
            blocks,
            row.id in queued,
            row.type == "input.rejected",
            if (row.type == "control.interrupt") "run.cancelled"
            else row.type.takeIf { row.terminal || it == "output.error" },
            if (row.type == "run.failed") row.failureReason else legacyReason?.wireValue,
            queueSequence = row.seqId.takeIf { row.id in pending },
            queuedWorkflow =
                if (row.id in queued) {
                    val document = row.userMessage as? JsonObject
                    val part =
                        (document?.get("parts") as? JsonArray)
                            ?.asSequence()
                            ?.mapNotNull { it as? JsonObject }
                            ?.firstOrNull { it.text("type") == "automation" }
                    QueuedWorkflow(part?.text("workflowName"), part?.text("automationBrief"))
                } else null,
            sourceSeqId = row.seqId,
            occurredAtMillis =
                if (
                    role == HistoryRole.User && row.runId != null ||
                        row.terminal ||
                        row.type == "control.interrupt"
                )
                    row.timeMillis()
                else null,
            followups =
                if (row.type == "output.followups") conversationFollowups(row.content) else null,
        )
    }
    val endedRuns = terminals + interrupted
    val running = historyIsRunning(rows, endedRuns)
    // Web selects the last distinct live run, independently of the overall run indicator.
    val liveRunIds = controls.liveRunIds
    val execution =
        when {
            running -> HistoryExecution.Running
            pending.isNotEmpty() -> HistoryExecution.Queued
            else ->
                // A late event from an older run stays with that turn, including in this summary.
                when (
                    messages
                        .lastOrNull {
                            it.status == "run.completed" ||
                                it.status == "run.failed" ||
                                it.status == "run.cancelled"
                        }
                        ?.status
                ) {
                    "run.completed" -> HistoryExecution.Completed
                    "run.failed" -> HistoryExecution.Failed
                    "run.cancelled" -> HistoryExecution.Cancelled
                    else -> HistoryExecution.Idle
                }
        }
    return HistoryTranscript(
        messages,
        execution,
        rows.count { it.type == "output.message" },
        liveRunIds.lastOrNull(),
        checkpoint.rows.flatMapTo(hashSetOf()) { listOfNotNull(it.id, it.revokesId) },
        liveRunIds,
        controls.terminatedRunIds,
        pending,
        controls.revocableInputIds,
        chatResourceReferences(checkpoint.rows),
    )
}

/** Match Web's run indicator: old activity cannot revive a newer terminal's settled state. */
private fun historyIsRunning(rows: List<HistoryEvent>, endedRuns: Set<String>): Boolean {
    val starts = mutableMapOf<String, Int>()
    var newestLiveStart: Int? = null
    for ((index, row) in rows.withIndex()) {
        if (row.type != "input.prompt" && row.type != "input.rejected") continue
        val run = row.runId ?: continue
        val start = starts.getOrPut(run) { index }
        if (run !in endedRuns) newestLiveStart = maxOf(newestLiveStart ?: start, start)
    }
    for (row in rows.asReversed()) {
        // An interrupt's raw runId is its target, not ownership of new activity.
        if (row.type == "usage.recorded" || row.type == "control.interrupt") continue
        if (row.terminal) {
            val start = starts[row.runId] ?: return false
            return newestLiveStart?.let { it > start } == true
        }
        if (row.runId != null && row.runId !in endedRuns) return true
        if (row.runId == null && (row.type == "output.message" || row.type == "output.error"))
            return false
    }
    return false
}

private fun userBlocks(value: JsonElement?): List<HistoryBlock> {
    val document = value as? JsonObject
    val parts = document?.get("parts") as? JsonArray
    if ((document?.get("version") as? JsonPrimitive)?.intOrNull != 1 || parts == null)
        return listOf(HistoryBlock(HistoryBlockKind.Unsupported, value?.toString() ?: "null"))
    if (parts.isEmpty()) return listOf(HistoryBlock(HistoryBlockKind.Unsupported, value.toString()))
    return parts.mapNotNull { part ->
        val objectPart = part as? JsonObject
        when (objectPart?.text("type")) {
            "text" ->
                objectPart.text("text")?.let { HistoryBlock(HistoryBlockKind.Text, it) }
                    ?: HistoryBlock(HistoryBlockKind.Unsupported, part.toString())
            "model",
            "additional_info",
            "source" -> null
            "chat_thread",
            "template" -> objectPart.reference("titleSnapshot")
            "project" -> objectPart.reference("nameSnapshot")
            "file" -> {
                val id = objectPart.text("fileId")
                val name = objectPart.text("filenameSnapshot")
                val type = objectPart.text("contentType")
                if (id.isNullOrBlank() || name.isNullOrBlank() || type.isNullOrBlank())
                    objectPart.reference("filenameSnapshot")
                else ChatAttachmentReference(id, name, type).historyBlock()
            }
            "automation" -> objectPart.reference("workflowName")
            "feedback" -> objectPart.reference("quote")
            "attachment",
            "image",
            "annotation" -> objectPart.reference()
            else -> HistoryBlock(HistoryBlockKind.Unsupported, part.toString())
        }
    }
}

private fun JsonObject.reference(titleKey: String? = null) =
    HistoryBlock(HistoryBlockKind.Reference, toString(), titleKey?.let { text(it) })
