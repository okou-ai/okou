package ai.okou.android.chat

import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.SendRequestVariant1
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant9
import ai.okou.android.connectors.ChatConnectorOverride
import java.io.File
import kotlin.time.TimeMark
import kotlinx.serialization.Required
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

internal const val CONNECTOR_DRAFT_JOURNAL_FORMAT = 4

/** A pending operation is a frozen request, independent of the next editable draft. */
@Serializable
data class PendingText(
    val eventId: String,
    val threadId: String,
    val create: CreateThreadRequest?,
    val send: SendRequestVariant1,
    val stage: TextStage,
    @Transient val connectorOverrides: List<ChatConnectorOverride> = emptyList(),
    @Transient val started: TimeMark? = null,
    @Transient val draftModel: DraftModelSelection? = null,
    @Transient val attachmentReferences: List<ChatAttachmentReference> = emptyList(),
    @Transient val attachmentFiles: Map<String, File> = emptyMap(),
)

internal val PendingText.awaitingConnectorSetup: Boolean
    get() = stage == TextStage.Created && connectorOverrides.isNotEmpty()

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

internal val TextDisposition.hasLeftQueue: Boolean
    get() = this != TextDisposition.Accepted && this != TextDisposition.Queued

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
    val sequence: Long? = null,
    val attachments: List<ChatAttachmentReference> = emptyList(),
    val attachmentFiles: Map<String, File> = emptyMap(),
    internal val keepAcknowledgedBubble: Boolean = disposition == TextDisposition.Accepted,
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
    val newChatConnectorOverrides: List<ChatConnectorOverride> = emptyList(),
    val retainedDraftConnectorOverrides: Map<String, List<ChatConnectorOverride>> = emptyMap(),
    val newChatModel: DraftModelSelection? = null,
    // A recorded null restores server-default inheritance for a rejected new chat.
    val retainedDraftModels: Map<String, DraftModelSelection?> = emptyMap(),
    val retainedDraftAttachments: Map<String, List<ChatAttachmentReference>> = emptyMap(),
)

internal fun ComposerJournal.withoutOrdinaryPending(): ComposerJournal =
    copy(
        entries =
            entries
                .mapValues { (_, entry) ->
                    if (
                        entry.pending != null &&
                            entry.pending.eventId != entry.recovery?.send?.clientEventId
                    )
                        entry.copy(pending = null)
                    else entry
                }
                .filterValues { it != ComposerEntry() },
    )

internal fun ComposerJournal.restoreDraftsWithoutReplaying(): ComposerJournal {
    val recovered =
        entries
            .mapNotNull { (_, entry) ->
                val pending = entry.pending ?: return@mapNotNull null
                if (pending.eventId == entry.recovery?.send?.clientEventId) return@mapNotNull null
                pending.eventId to pending.send.prompt
            }
            .toMap()
    return withoutOrdinaryPending().copy(retainedDrafts = retainedDrafts + recovered)
}

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

class PendingAttachmentSelection(val draftKey: String, val source: String) {
    internal fun destination(journal: ComposerJournal?): String {
        // A new-chat send can move an editable draft while Android owns the picker.
        val created = journal?.entries?.get(source)?.createdThreadId
        return if (draftKey == "new:" && created != null) "thread:$created" else draftKey
    }
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

enum class RecoveryOperationPhase {
    Preparing,
    CheckingReset,
}

internal data class AttachmentSkip(
    val target: ComposerTarget,
    val draftKey: String,
    val attachments: List<DraftChatAttachment>,
)

data class ComposerState(
    val journal: ComposerJournal? = null,
    val persistence: ComposerPersistence = ComposerPersistence.Loading,
    val context: ComposerContext = ComposerContext.Idle,
    val busy: Set<String> = emptySet(),
    val checking: Set<String> = emptySet(),
    val recovering: Map<RecoverySelection, RecoveryOperationPhase> = emptyMap(),
    val recoveryFailures: Map<String, RecoverySelection> = emptyMap(),
    val failed: Set<String> = emptySet(),
    val unobserved: Set<String> = emptySet(),
    val synchronization: Map<String, ComposerSync> = emptyMap(),
    internal val receiptMessages: Map<String, ComposerMessagePreview> = emptyMap(),
    internal val attachmentProgress: Map<String, Int> = emptyMap(),
    internal val readingAttachmentSelections: List<PendingAttachmentSelection> = emptyList(),
) {
    fun draftKey(target: ComposerTarget): String {
        val redirected = journal?.entries?.get(target.key)?.createdThreadId
        return redirected?.let { "thread:$it" } ?: target.threadId?.let { "thread:$it" } ?: "new:"
    }

    fun entry(target: ComposerTarget): ComposerEntry {
        val journal = journal
        val entry = journal?.entries?.get(target.key) ?: ComposerEntry()
        return if (journal != null && journal.format >= 3)
            entry.copy(text = journal.drafts[draftKey(target)]?.text.orEmpty())
        else entry
    }

    internal fun connectorOverrides(target: ComposerTarget): List<ChatConnectorOverride> {
        if (target.threadId != null) return emptyList()
        val journal = journal ?: return emptyList()
        return journal.entries[target.key]?.pending?.connectorOverrides
            ?: journal.newChatConnectorOverrides
    }

    internal fun canEditDraftConnectors(target: ComposerTarget): Boolean {
        if (target.threadId != null || journal == null || target.key in busy) return false
        val entry = entry(target)
        return entry.createdThreadId == null &&
            (entry.pending == null || entry.pending.stage == TextStage.Created)
    }

    internal fun connectorSetupFailed(key: String): Boolean =
        key in failed && journal?.entries?.get(key)?.pending?.awaitingConnectorSetup == true

    fun sync(target: ComposerTarget) = synchronization[draftKey(target)] ?: ComposerSync.Idle

    internal fun attachments(target: ComposerTarget): List<DraftChatAttachment> =
        journal?.drafts?.get(draftKey(target))?.attachments.orEmpty()

    internal fun attachmentSkip(target: ComposerTarget): AttachmentSkip? =
        attachments(target)
            .filter { it.reference == null && it.failure != null }
            .takeIf { it.isNotEmpty() }
            ?.let { AttachmentSkip(target, draftKey(target), it) }

    internal fun canEditDraftModel(target: ComposerTarget) =
        journal != null &&
            target.threadId == null &&
            draftKey(target) == "new:" &&
            entry(target).pending == null

    internal fun messagesFor(threadId: String): List<ComposerMessagePreview> = buildList {
        receiptMessages.values.filterTo(this) { it.threadId == threadId }
        journal?.entries?.forEach { (key, entry) ->
            val pending = entry.pending?.takeIf { it.threadId == threadId } ?: return@forEach
            val delivery =
                when {
                    pending.started != null && !connectorSetupFailed(key) -> PendingDelivery.Sending
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

    fun canSend(target: ComposerTarget): Boolean {
        val entry = entry(target)
        val draftKey = draftKey(target)
        val attachments = journal?.drafts?.get(draftKey)?.attachments.orEmpty()
        return journal != null &&
            (target.key !in busy || target.key in checking) &&
            entry.pending == null &&
            target.threadId?.let(::pendingNewChat) == null &&
            entry.createdThreadId == null &&
            readingAttachmentSelections.none { it.destination(journal) == draftKey } &&
            attachments.all { it.reference != null || it.failure != null } &&
            (!entry.text.isBlankWebDraft() || attachments.any { it.reference != null })
    }
}

internal val PendingText.displayText: String
    get() = send.prompt.takeUnless { send.hasTextContent == false }.orEmpty()

internal fun PendingText.preview(
    disposition: TextDisposition? = null,
    pendingDelivery: PendingDelivery? = null,
    sequence: Long? = null,
) =
    ComposerMessagePreview(
        eventId,
        threadId,
        displayText,
        disposition,
        pendingDelivery,
        sequence,
        attachmentReferences.ifEmpty {
            send.userMessage.parts
                .filterIsInstance<SendRequestVariant1UserMessagePartsItemVariant9>()
                .map { ChatAttachmentReference(it.fileId, it.filenameSnapshot, it.contentType) }
        },
        attachmentFiles.takeIf { pendingDelivery != null }.orEmpty(),
    )
