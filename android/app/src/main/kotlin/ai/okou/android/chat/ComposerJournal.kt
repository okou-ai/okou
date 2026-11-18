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
    val defaultAgentId: String? = null,
)

data class ComposerTarget(
    val threadId: String? = null,
    val agentId: String? = null,
    val projectId: String? = null,
) {
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
}

data class ComposerState(
    val journal: ComposerJournal? = null,
    val persistence: ComposerPersistence = ComposerPersistence.Loading,
    val context: ComposerContext = ComposerContext.Idle,
    val defaultAgentId: String? = null,
    val busy: Set<String> = emptySet(),
    val checking: Set<String> = emptySet(),
    val failed: Set<String> = emptySet(),
    val unobserved: Set<String> = emptySet(),
    val synchronization: Map<String, ComposerSync> = emptyMap(),
) {
    fun draftKey(target: ComposerTarget): String {
        val redirected = journal?.entries?.get(target.key)?.createdThreadId
        return redirected?.let { "thread:$it" }
            ?: target.threadId?.let { "thread:$it" }
            ?: (defaultAgentId ?: journal?.defaultAgentId)?.let { "agent:$it" }
            ?: "new:"
    }

    fun entry(target: ComposerTarget): ComposerEntry {
        val entry = journal?.entries?.get(target.key) ?: ComposerEntry()
        return if (journal?.format == 3)
            entry.copy(text = journal.drafts[draftKey(target)]?.text.orEmpty())
        else entry
    }

    fun sync(target: ComposerTarget) = synchronization[draftKey(target)] ?: ComposerSync.Idle

    fun canSend(target: ComposerTarget): Boolean =
        journal != null &&
            persistence != ComposerPersistence.Failed &&
            (target.key !in busy || target.key in checking) &&
            entry(target).pending == null &&
            entry(target).createdThreadId == null &&
            !entry(target).text.isBlankWebDraft() &&
            (if (target.threadId != null) target.agentId != null
            else context == ComposerContext.Ready)
}
