package ai.okou.android.chat

import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.SendRequestVariant1
import kotlinx.serialization.Required
import kotlinx.serialization.Serializable

/** A pending operation is a frozen request, independent of the next editable draft. */
@Serializable
data class PendingText(
    val eventId: String,
    val threadId: String,
    val create: CreateThreadRequest?,
    val send: SendRequestVariant1,
    val stage: TextStage,
)

@Serializable
enum class TextStage {
    Prepared,
    Creating,
    Created,
    Sending,
}

@Serializable
enum class TextDisposition {
    Accepted,
    Queued,
    Consumed,
    Completed,
    Failed,
    Cancelled,
    Rejected,
    Revoked,
}

@Serializable
data class TextReceipt(val threadId: String, val eventId: String, val disposition: TextDisposition)

enum class PendingDelivery {
    Sending,
    Checking,
    Unconfirmed,
}

/** Local presentation of a frozen input while its history row is unavailable. */
data class ComposerMessagePreview(
    val eventId: String,
    val threadId: String,
    val text: String,
    val disposition: TextDisposition? = null,
    val pendingDelivery: PendingDelivery? = null,
)

@Serializable
data class ComposerEntry(
    val text: String = "",
    val pending: PendingText? = null,
    val receipt: TextReceipt? = null,
    val createdThreadId: String? = null,
    val recovery: ComposerRecovery? = null,
)

@Serializable
data class ComposerJournal(
    @Required val format: Int = 1,
    val entries: Map<String, ComposerEntry> = emptyMap(),
    val drafts: Map<String, EditableComposerDraft> = emptyMap(),
    val retainedDrafts: Map<String, String> = emptyMap(),
)

internal fun ComposerJournal.acceptedNewChats(): List<ProvisionalChat> =
    entries.entries.toList().asReversed().mapNotNull { (key, entry) ->
        if (!key.startsWith("new:")) return@mapNotNull null
        val id = entry.createdThreadId ?: return@mapNotNull null
        ProvisionalChat(id, key.removePrefix("new:").ifEmpty { null })
    }

data class ComposerTarget(val threadId: String? = null, val projectId: String? = null) {
    val key: String
        get() = threadId?.let { "thread:$it" } ?: "new:${projectId.orEmpty()}"
}

enum class ComposerPersistence {
    Loading,
    Pending,
    Durable,
    Failed,
}

enum class ComposerContext {
    Idle,
    Loading,
    Ready,
    Unavailable,
    Failed,
    NetworkFailed,
}

data class ComposerState(
    val journal: ComposerJournal? = null,
    val persistence: ComposerPersistence = ComposerPersistence.Loading,
    val context: ComposerContext = ComposerContext.Idle,
    val busy: Set<String> = emptySet(),
    val checking: Set<String> = emptySet(),
    val failed: Set<String> = emptySet(),
    val unobserved: Set<String> = emptySet(),
    val synchronization: Map<String, ComposerSync> = emptyMap(),
    internal val receiptMessages: Map<String, ComposerMessagePreview> = emptyMap(),
) {
    fun draftKey(target: ComposerTarget): String {
        val redirected = journal?.entries?.get(target.key)?.createdThreadId
        return redirected?.let { "thread:$it" } ?: target.threadId?.let { "thread:$it" } ?: "new:"
    }

    fun entry(target: ComposerTarget): ComposerEntry {
        val entry = journal?.entries?.get(target.key) ?: ComposerEntry()
        return if (journal?.format == 3)
            entry.copy(text = journal.drafts[draftKey(target)]?.text.orEmpty())
        else entry
    }

    fun sync(target: ComposerTarget) = synchronization[draftKey(target)] ?: ComposerSync.Idle

    internal fun messagesFor(threadId: String): List<ComposerMessagePreview> = buildList {
        receiptMessages.values.filterTo(this) { it.threadId == threadId }
        journal?.entries?.forEach { (key, entry) ->
            val pending = entry.pending?.takeIf { it.threadId == threadId } ?: return@forEach
            val delivery =
                when {
                    key in checking -> PendingDelivery.Checking
                    key in busy -> PendingDelivery.Sending
                    else -> PendingDelivery.Unconfirmed
                }
            add(pending.preview(pendingDelivery = delivery))
        }
    }

    internal fun pendingNewChat(threadId: String): ComposerTarget? =
        journal?.entries?.values?.firstNotNullOfOrNull { entry ->
            entry.pending
                ?.takeIf { it.threadId == threadId }
                ?.create
                ?.let { ComposerTarget(projectId = it.projectId) }
        }

    internal fun pendingNewChats(): List<ProvisionalChat> =
        journal?.entries.orEmpty().values.toList().asReversed().mapNotNull { entry ->
            val pending = entry.pending ?: return@mapNotNull null
            val create = pending.create ?: return@mapNotNull null
            ProvisionalChat(pending.threadId, create.projectId)
        }

    fun canSend(target: ComposerTarget): Boolean =
        journal != null &&
            persistence != ComposerPersistence.Failed &&
            (target.key !in busy || target.key in checking) &&
            entry(target).pending == null &&
            target.threadId?.let(::pendingNewChat) == null &&
            entry(target).createdThreadId == null &&
            !entry(target).text.isBlankWebDraft()
}

internal fun PendingText.preview(
    disposition: TextDisposition? = null,
    pendingDelivery: PendingDelivery? = null,
) = ComposerMessagePreview(eventId, threadId, send.prompt, disposition, pendingDelivery)
