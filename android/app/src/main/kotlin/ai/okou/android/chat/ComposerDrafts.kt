package ai.okou.android.chat

import ai.okou.android.api.generated.ComposerDraft
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull

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
    val attachments: List<DraftChatAttachment> = emptyList(),
)

internal val EditableComposerDraft.hasContent: Boolean
    get() = !text.isBlankWebDraft() || attachments.isNotEmpty()

internal data class EditableDraftContent(
    val text: String,
    val attachments: List<ChatAttachmentReference>,
)

enum class ComposerSync {
    Idle,
    Loading,
    Saving,
    Saved,
    Failed,
    NetworkFailed,
    Unsupported,
}

internal enum class ComposerPrefillResult {
    Ready,
    Unavailable,
    NetworkFailed,
}

/** Leave documents with annotations, references or unfamiliar parts untouched on the server. */
internal fun ComposerDraft.editableContent(): EditableDraftContent? {
    val rawAttachments = this["draftAttachments"] ?: return null
    val files =
        if (rawAttachments == JsonNull) emptyList()
        else {
            val list = rawAttachments as? JsonArray ?: return null
            list.map {
                val fields = it as? JsonObject ?: return null
                val id = fields.stringField("id") ?: return null
                val filename = fields.stringField("filename") ?: return null
                val type = fields.stringField("contentType") ?: return null
                val url = fields.stringField("url") ?: return null
                val size = (fields["size"] as? JsonPrimitive)?.longOrNull ?: return null
                ChatAttachmentReference(id, filename, type, size, url)
            }
        }
    val document = this["draftUserMessage"] ?: return null
    if (document == JsonNull) return if (files.isEmpty()) EditableDraftContent("", files) else null
    val message = document as? JsonObject ?: return null
    if (message.keys != setOf("version", "parts") || message["version"] != JsonPrimitive(1))
        return null
    val parts = message["parts"] as? JsonArray ?: return null
    var fileIndex = 0
    val text = buildString {
        for (raw in parts) {
            val part = raw as? JsonObject ?: return null
            when (part["type"]) {
                JsonPrimitive("text") -> {
                    if (fileIndex != 0 || part.keys != setOf("type", "text")) return null
                    append(part.stringField("text") ?: return null)
                }
                JsonPrimitive("file") -> {
                    val file = files.getOrNull(fileIndex++) ?: return null
                    if (part != file.draftPart()) return null
                }
                else -> return null
            }
        }
    }
    return if (fileIndex == files.size) EditableDraftContent(text, files) else null
}

internal fun ComposerDraft.plainText() =
    editableContent()?.takeIf { it.attachments.isEmpty() }?.text

private fun JsonObject.stringField(key: String) =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

// Match Web's ECMAScript String.trim set; Kotlin isBlank differs for BOM and control characters.
internal fun String.isBlankWebDraft() = all {
    it in '\u0009'..'\u000d' ||
        it in '\u2000'..'\u200a' ||
        it in " \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff"
}

internal fun draftThreadIdsForList(
    confirmedIds: Set<String>?,
    localDrafts: Map<String, EditableComposerDraft>,
): Set<String> = buildSet {
    addAll(confirmedIds.orEmpty())
    for ((key, draft) in localDrafts) {
        if (!key.startsWith("thread:") || (!draft.dirty && confirmedIds != null)) continue
        val id = key.removePrefix("thread:")
        if (draft.hasContent) add(id) else remove(id)
    }
}

internal fun plainDraftDocument(
    text: String,
    attachments: List<ChatAttachmentReference> = emptyList(),
): JsonObject = buildJsonObject {
    val parts = buildList {
        if (!text.isBlankWebDraft())
            add(
                buildJsonObject {
                    put("type", JsonPrimitive("text"))
                    put("text", JsonPrimitive(text))
                },
            )
        attachments.forEach { add(it.draftPart()) }
    }
    put(
        "draftUserMessage",
        if (parts.isEmpty()) JsonNull
        else
            buildJsonObject {
                put("version", JsonPrimitive(1))
                put("parts", JsonArray(parts))
            },
    )
    put(
        "draftAttachments",
        if (attachments.isEmpty()) JsonNull
        else
            JsonArray(
                attachments.map {
                    buildJsonObject {
                        put("id", JsonPrimitive(it.id))
                        put("url", JsonPrimitive(checkNotNull(it.url)))
                        put("filename", JsonPrimitive(it.filename))
                        put("contentType", JsonPrimitive(it.contentType))
                        put("size", JsonPrimitive(checkNotNull(it.size)))
                    }
                },
            ),
    )
}

private fun ChatAttachmentReference.draftPart() = buildJsonObject {
    put("type", JsonPrimitive("file"))
    put("fileId", JsonPrimitive(id))
    put("filenameSnapshot", JsonPrimitive(filename))
    put("contentType", JsonPrimitive(contentType))
}

// These historical keys record ownership. Other retained entries use an event ID or
// an obsolete agent scope and need explicit selection.
internal fun ComposerJournal.compatibleDraftKey(target: ComposerTarget): String? =
    listOf(target.key, "draft:${target.key}").singleOrNull { it in retainedDrafts }

internal fun String.canRestoreIn(target: ComposerTarget): Boolean {
    val owner = removePrefix("draft:")
    val scoped = owner.startsWith("thread:") || owner.startsWith("new:")
    return !scoped || owner == target.key
}

internal fun ComposerJournal.manualDrafts(target: ComposerTarget): Map<String, String> {
    val automatic = compatibleDraftKey(target)
    return retainedDrafts.filterKeys { it != automatic && it.canRestoreIn(target) }
}

/** Preserve every old editable candidate and all frozen requests before changing ownership. */
internal fun ComposerJournal.withServerDrafts(): ComposerJournal {
    if (format >= 3) {
        val retiredDrafts = drafts.filterKeys {
            it != ServerDraftTarget().key && !it.startsWith("thread:")
        }
        if (retiredDrafts.isEmpty()) return this
        // Keep old device-local text available for restoration into an empty composer.
        val candidates =
            retiredDrafts.entries
                .filter { it.value.text.isNotEmpty() }
                .associate { (key, draft) -> "draft:$key" to draft.text }
        return copy(
            drafts = drafts - retiredDrafts.keys,
            retainedDrafts = retainedDrafts + candidates,
        )
    }
    val retained = entries.filterValues { it.text.isNotEmpty() }.mapValues { it.value.text }
    return copy(
        format = 3,
        entries = entries.mapValues { it.value.copy(text = "") },
        retainedDrafts = retained,
    )
}
