package ai.okou.android.chat

import ai.okou.android.api.generated.ComposerDraft
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** The same two draft identities used by Web; Project is only create-thread context. */
data class ServerDraftTarget(val threadId: String? = null) {
    val key: String
        get() = threadId?.let { "thread:$it" } ?: "new:"
}

@Serializable
data class EditableComposerDraft(
    val text: String = "",
    val dirty: Boolean = false,
    val revision: Long = 0,
    val source: String? = null,
)

enum class ComposerSync {
    Idle,
    Loading,
    Saving,
    Saved,
    Failed,
    Unsupported,
}

/** Null means unsupported/unreadable, while an empty String is authoritative empty content. */
internal fun ComposerDraft.plainText(): String? {
    val attachments = this["draftAttachments"] ?: return null
    if (attachments != JsonNull && attachments != JsonArray(emptyList())) return null
    val document = this["draftUserMessage"] ?: return null
    if (document == JsonNull) return ""
    val message = document as? JsonObject ?: return null
    if (message.keys != setOf("version", "parts") || message["version"] != JsonPrimitive(1))
        return null
    val parts = message["parts"] as? JsonArray ?: return null
    return buildString {
        for (raw in parts) {
            val part = raw as? JsonObject ?: return null
            if (part.keys != setOf("type", "text") || part["type"] != JsonPrimitive("text"))
                return null
            val text = part["text"] as? JsonPrimitive ?: return null
            if (!text.isString) return null
            append(text.content)
        }
    }
}

// Match Web's ECMAScript String.trim set; Kotlin isBlank differs for BOM and control characters.
internal fun String.isBlankWebDraft() = all {
    it in '\u0009'..'\u000d' ||
        it in '\u2000'..'\u200a' ||
        it in " \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff"
}

internal fun plainDraftDocument(text: String): JsonObject = buildJsonObject {
    put(
        "draftUserMessage",
        if (text.isBlankWebDraft()) JsonNull
        else
            buildJsonObject {
                put("version", JsonPrimitive(1))
                put(
                    "parts",
                    JsonArray(
                        listOf(
                            buildJsonObject {
                                put("type", JsonPrimitive("text"))
                                put("text", JsonPrimitive(text))
                            }
                        )
                    ),
                )
            },
    )
    put("draftAttachments", JsonNull)
}

/** Preserve every old editable candidate and all frozen requests before changing ownership. */
internal fun ComposerJournal.withServerDrafts(): ComposerJournal {
    if (format == 3) {
        val retiredDrafts =
            drafts.filterKeys { it != ServerDraftTarget().key && !it.startsWith("thread:") }
        if (retiredDrafts.isEmpty()) return this
        // Keep old device-local text available for explicit restore into an empty composer.
        val candidates =
            retiredDrafts.entries
                .filter { it.value.text.isNotEmpty() }
                .associate { (key, draft) -> "draft:$key" to draft.text }
        return copy(
            drafts = drafts - retiredDrafts.keys,
            retainedDrafts = retainedDrafts + candidates,
        )
    }
    val drafts =
        entries
            .filterKeys { it.startsWith("thread:") }
            .filterValues { it.text.isNotEmpty() }
            .mapValues { (key, entry) -> EditableComposerDraft(entry.text, true, 1, key) }
            .toMutableMap()
    val newDrafts =
        entries.filterKeys { it.startsWith("new:") }.filterValues { it.text.isNotEmpty() }
    val preferred =
        newDrafts["new:"]?.let { "new:" to it }
            ?: newDrafts.entries.singleOrNull()?.let { it.key to it.value }
    preferred?.let { (key, entry) ->
        drafts["new:"] = EditableComposerDraft(entry.text, true, 1, key)
    }
    val retained =
        entries
            .filterKeys { !it.startsWith("thread:") && it != preferred?.first }
            .filterValues { it.text.isNotEmpty() }
            .mapValues { it.value.text }
    return copy(
        format = 3,
        entries = entries.mapValues { it.value.copy(text = "") },
        drafts = drafts,
        retainedDrafts = retained,
    )
}
