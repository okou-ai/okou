package ai.okou.android.chat

import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.SendRequestVariant1
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
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
)

@Serializable
@OptIn(ExperimentalSerializationApi::class)
data class ComposerJournal(
    @EncodeDefault val format: Int = 1,
    val entries: Map<String, ComposerEntry> = emptyMap(),
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
    val openedThread: String? = null,
    val openedFrom: String? = null,
) {
    fun entry(target: ComposerTarget) = journal?.entries?.get(target.key) ?: ComposerEntry()

    fun canSend(target: ComposerTarget): Boolean =
        journal != null &&
            persistence != ComposerPersistence.Failed &&
            (target.key !in busy || target.key in checking) &&
            entry(target).pending == null &&
            entry(target).text.isNotBlank() &&
            (if (target.threadId != null) target.agentId != null
            else context == ComposerContext.Ready)
}
