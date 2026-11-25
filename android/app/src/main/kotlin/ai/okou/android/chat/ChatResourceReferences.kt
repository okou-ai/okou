package ai.okou.android.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

internal data class ChatResourceReferences(
    val origin: ChatResourceOrigin?,
    val workflowIds: Set<String>,
)

internal sealed interface ChatResourceOrigin {
    data class External(val kind: String, val href: String?, val clientName: String?) :
        ChatResourceOrigin

    data class Forwarded(val threadId: String, val runId: String) : ChatResourceOrigin
}

private val resourceId = Regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")

internal fun chatResourceReferences(events: List<HistoryEvent>): ChatResourceReferences {
    val firstRun = events.firstNotNullOfOrNull { it.runId }
    var origin: ChatResourceOrigin? = null
    val workflows = mutableSetOf<String>()
    for (event in events) {
        val run = event.runId ?: continue
        val type = event.type
        val automation = type == "input.automation"
        val launch = run == firstRun && event.id == run && (type == "input.prompt" || automation)
        if (!launch && !automation) continue
        val document = event.userMessage as? JsonObject ?: continue
        if ((document["version"] as? JsonPrimitive)?.intOrNull != 1) continue
        val parts = document["parts"] as? JsonArray ?: continue
        for (part in parts) {
            val annotation = part as? JsonObject ?: continue
            if (launch && origin == null) origin = annotation.origin()
            if (automation && annotation.text("type") == "automation")
                annotation.resourceId("workflowId")?.let(workflows::add)
        }
    }
    return ChatResourceReferences(origin, workflows)
}

private fun JsonObject.origin(): ChatResourceOrigin? =
    when (text("type")) {
        "source" ->
            text("kind")?.let { ChatResourceOrigin.External(it, text("href"), text("clientName")) }
        "chat_thread" -> {
            val thread = resourceId("threadId")
            val run = resourceId("runId")
            if (thread == null || run == null) null else ChatResourceOrigin.Forwarded(thread, run)
        }
        else -> null
    }

private fun JsonObject.resourceId(field: String) = text(field)?.takeIf(resourceId::matches)
