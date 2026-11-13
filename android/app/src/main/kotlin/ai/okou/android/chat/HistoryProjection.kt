package ai.okou.android.chat

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
    Unsupported,
    Error,
}

enum class HistoryExecution {
    Idle,
    Queued,
    Running,
    Stopping,
    Completed,
    Failed,
    Cancelled,
}

data class HistoryBlock(val kind: HistoryBlockKind, val text: String)

data class HistoryMessage(
    val id: String,
    val runId: String?,
    val role: HistoryRole,
    val blocks: List<HistoryBlock>,
    val queued: Boolean = false,
    val rejected: Boolean = false,
    val status: String? = null,
)

data class HistoryTranscript(
    val messages: List<HistoryMessage>,
    val execution: HistoryExecution,
    val workSteps: Int,
)

internal fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull

/** Project confirmed event facts, without reinterpreting unknown JSON as a text-only bubble. */
fun projectHistory(checkpoint: HistoryCheckpoint): HistoryTranscript {
    checkpoint.validate()
    val revoked = checkpoint.rows.mapNotNullTo(hashSetOf()) { it.revokesId }
    val rows = checkpoint.rows.filter { it.id !in revoked }
    val terminals = rows.filter { it.terminal }.mapNotNullTo(hashSetOf()) { it.runId }
    val active =
        rows
            .filter { it.type !in setOf("control.interrupt", "control.revoke", "usage.recorded") }
            .mapNotNullTo(hashSetOf()) { it.runId } - terminals
    val interrupted =
        rows.filter { it.type == "control.interrupt" }.mapNotNullTo(hashSetOf()) { it.runId }
    val queued =
        rows
            .filter { it.runId == null && it.type in setOf("input.prompt", "input.automation") }
            .mapTo(hashSetOf()) { it.id }
    // Like Web, place an older run's late event with its run; queued inputs come last.
    val turns = linkedMapOf<String, MutableList<HistoryEvent>>()
    for (row in rows) turns
        .getOrPut(
            if (row.id in queued) "queued:${row.id}"
            else row.runId?.let { "run:$it" } ?: "event:${row.id}"
        ) {
            mutableListOf()
        }
        .add(row)
    val ordered =
        turns.values.filter { it.none { row -> row.id in queued } }.flatten() +
            rows
                .filter { it.id in queued }
                .sortedWith(
                    compareBy<HistoryEvent> { it.type != "input.prompt" }
                        .thenBy { it.createdAt }
                        .thenBy { it.id }
                )
    val messages =
        ordered.mapNotNull { row ->
            val payload = row.payload
            val blocks = mutableListOf<HistoryBlock>()
            val role =
                when (row.type) {
                    "input.prompt",
                    "input.rejected",
                    "input.budget",
                    "input.automation" -> {
                        val document = payload?.get("userMessage")
                        if (
                            row.type == "input.automation" &&
                                (document == null || document === JsonNull)
                        )
                            return@mapNotNull null
                        blocks.addAll(userBlocks(document))
                        payload?.text("error")?.let {
                            blocks.add(HistoryBlock(HistoryBlockKind.Error, it))
                        }
                        HistoryRole.User
                    }
                    "output.message" -> {
                        payload?.text("content")?.let {
                            blocks.add(HistoryBlock(HistoryBlockKind.Text, it))
                        }
                            ?: blocks.add(
                                HistoryBlock(HistoryBlockKind.Unsupported, row.wire.toString())
                            )
                        HistoryRole.Assistant
                    }
                    "output.error",
                    "run.failed" -> {
                        payload?.text("content")?.let {
                            blocks.add(HistoryBlock(HistoryBlockKind.Text, it))
                        }
                        payload?.text("error")?.let {
                            blocks.add(HistoryBlock(HistoryBlockKind.Error, it))
                        }
                        row.wire.text("failureReason")?.let {
                            blocks.add(HistoryBlock(HistoryBlockKind.Reference, it))
                        }
                        HistoryRole.System
                    }
                    "run.cancelled",
                    "run.completed" -> {
                        payload?.text("content")?.let {
                            blocks.add(HistoryBlock(HistoryBlockKind.Text, it))
                        }
                        payload?.text("error")?.let {
                            blocks.add(HistoryBlock(HistoryBlockKind.Error, it))
                        }
                        HistoryRole.Assistant
                    }
                    "usage.recorded" -> {
                        payload?.get("usage")?.let {
                            blocks.add(HistoryBlock(HistoryBlockKind.Reference, it.toString()))
                        }
                        if (blocks.isEmpty()) return@mapNotNull null
                        HistoryRole.System
                    }
                    "output.followups" -> {
                        payload?.text("content")?.let {
                            blocks.add(HistoryBlock(HistoryBlockKind.Reference, it))
                        }
                        if (blocks.isEmpty()) return@mapNotNull null
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
                row.type.takeIf { row.terminal || it == "output.error" },
            )
        }
    val execution =
        when {
            active.any { it in interrupted } -> HistoryExecution.Stopping
            active.isNotEmpty() -> HistoryExecution.Running
            queued.isNotEmpty() -> HistoryExecution.Queued
            else ->
                when (rows.lastOrNull { it.terminal }?.type) {
                    "run.completed" -> HistoryExecution.Completed
                    "run.failed" -> HistoryExecution.Failed
                    "run.cancelled" -> HistoryExecution.Cancelled
                    else -> HistoryExecution.Idle
                }
        }
    return HistoryTranscript(messages, execution, rows.count { it.type == "output.message" })
}

private fun userBlocks(value: JsonElement?): List<HistoryBlock> {
    val document = value as? JsonObject
    val parts = document?.get("parts") as? JsonArray
    if ((document?.get("version") as? JsonPrimitive)?.intOrNull != 1 || parts == null)
        return listOf(HistoryBlock(HistoryBlockKind.Unsupported, value?.toString() ?: "null"))
    return parts
        .map { part ->
            val objectPart = part as? JsonObject
            when (objectPart?.text("type")) {
                "text" ->
                    objectPart.text("text")?.let { HistoryBlock(HistoryBlockKind.Text, it) }
                        ?: HistoryBlock(HistoryBlockKind.Unsupported, part.toString())
                // Preserve the complete reference/annotation, including IDs and capability
                // metadata.
                "attachment",
                "file",
                "image",
                "annotation",
                "feedback",
                "chat_thread",
                "agent",
                "project",
                "template",
                "source",
                "automation",
                "model" -> HistoryBlock(HistoryBlockKind.Reference, part.toString())
                else -> HistoryBlock(HistoryBlockKind.Unsupported, part.toString())
            }
        }
        .ifEmpty { listOf(HistoryBlock(HistoryBlockKind.Unsupported, value.toString())) }
}
