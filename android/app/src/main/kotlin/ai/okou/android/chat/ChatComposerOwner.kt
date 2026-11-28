package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.AttachmentStorageRejection
import ai.okou.android.api.MaxChatAttachmentBytes
import ai.okou.android.api.boundedApiRetryDelayMillis
import ai.okou.android.api.continuousRetryDelayMillis
import ai.okou.android.api.continuousRetryDelays
import ai.okou.android.api.generated.CanonicalInteger1
import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.ResetSubscriptionResultOutcome
import ai.okou.android.api.generated.SendRequestVariant1
import ai.okou.android.api.generated.SendRequestVariant1UserMessage
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant1
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant1Type
import ai.okou.android.api.retryAfterDelayMillis
import ai.okou.android.api.retryAfterSeconds
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.connectors.ChatConnectorOverride
import ai.okou.android.connectors.ConnectorService
import ai.okou.android.settings.DefaultModelOptions
import android.net.Uri
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlin.time.Duration.Companion.days
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Main-thread transaction owner shared by attached workspace presentation controllers. */
internal class ChatComposerOwner(
    private val store: ComposerJournalStore,
    private val identity: WorkspaceIdentity,
) {
    class Connection(
        val service: ChatComposerService,
        val scope: CoroutineScope,
        val authorized: () -> Boolean,
        val onFailure: (Exception) -> Unit,
        val accepted: (String) -> Unit,
        val recovery: AssistantRecoveryModel? = null,
        val history: ConversationHistoryModel? = null,
        val chatList: ChatListModel? = null,
        val connectors: ConnectorService? = null,
        val workflowCatalog: ComposerWorkflowCatalog? = null,
    ) {
        var retired = false

        fun current() = !retired && scope.isActive && authorized()
    }

    private class Operation(
        val key: String,
        val connection: Connection,
        val checking: Boolean = false,
        val recovery: Pair<RecoverySelection, RecoveryOperationPhase>? = null,
    ) {
        var job: Job? = null
        var unsentReset: UnsentReset? = null
        var inputMayHaveBeenSent = false
    }

    private class UnsentReset(val previous: ComposerRecovery?, val prepared: ComposerRecovery)

    private val mutable = MutableStateFlow(ComposerState())
    val uiState = mutable.asStateFlow()
    private val localScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val connections = mutableSetOf<Connection>()
    private val operations = mutableMapOf<String, Operation>()
    private var restoring: Job? = null
    private var contextJob: Job? = null
    private var contextConnection: Connection? = null
    private var openedTarget: ComposerTarget? = null
    private var revision = 0L

    private class DraftWork(val connection: Connection, val target: ServerDraftTarget) {
        var job: Job? = null
        var refresh = false
    }

    private val draftWork = mutableMapOf<String, DraftWork>()
    private val readableDrafts = mutableSetOf<String>()
    private val attachmentJobs = mutableMapOf<String, Pair<Connection, Job>>()
    private val attachmentSlots = Semaphore(2)

    fun attachmentFile(key: String): File =
        store.attachmentDirectory(identity).resolve(UUID.fromString(key).toString())

    fun attach(connection: Connection) {
        connections += connection
        if (!connection.current()) return
        connection.chatList?.onAcceptedChatMissing = { acknowledge(connection, it) }
        val journal = mutable.value.journal
        if (journal == null) restoreJournal()
        else {
            connection.chatList?.retainAcceptedNewChats(journal.acceptedNewChats(), restored = true)
            resumeSends(connection)
            resumeAttachmentUploads(connection)
        }
    }

    fun detach(connection: Connection): Boolean {
        connection.chatList?.onAcceptedChatMissing = null
        val retired = draftWork.values.filter { it.connection === connection }.toList()
        val retiredUploads =
            attachmentJobs.values.filter { it.first === connection }.map { it.second }
        retiredUploads.forEach { it.cancel() }
        retired.forEach {
            draftWork.remove(it.target.key)
            it.job?.cancel()
        }
        if (contextConnection === connection) {
            contextJob?.cancel()
            contextJob = null
            contextConnection = null
            if (
                mutable.value.context != ComposerContext.Ready ||
                    connections.none { it !== connection && it.current() }
            )
                mutable.value = mutable.value.copy(context = ComposerContext.Idle)
        }
        operations.values
            .filter { it.connection === connection }
            .toList()
            .forEach { op ->
                finish(op)
                op.job?.cancel()
            }
        connections -= connection
        connections
            .firstOrNull { it.current() }
            ?.let { next ->
                retired.forEach { synchronize(next, it.target, refresh = true) }
                resumeSends(next)
                if (retiredUploads.isNotEmpty())
                    next.scope.launch {
                        retiredUploads.forEach { it.join() }
                        resumeAttachmentUploads(next)
                    }
            }
        if (connections.isNotEmpty()) return false
        localScope.cancel()
        return true
    }

    private fun current(op: Operation) = operations[op.key] === op && op.connection.current()

    private suspend fun requireCurrent(op: Operation) {
        currentCoroutineContext().ensureActive()
        if (!current(op)) throw CancellationException("Composer connection retired")
    }

    private fun replace(
        journal: ComposerJournal,
        receiptMessages: Map<String, ComposerMessagePreview> = mutable.value.receiptMessages,
    ) {
        val ticket = ++revision
        val value =
            if (journal.format < 2 && journal.entries.values.any { it.recovery != null })
                journal.copy(format = 2)
            else journal
        val pending = store.persist(identity, value.withoutOrdinaryPending())
        mutable.value =
            mutable.value.copy(
                journal = value,
                persistence = ComposerPersistence.Pending,
                receiptMessages = receiptMessages,
            )
        localScope.launch {
            val result =
                try {
                    pending.await()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    null
                }
            if (revision == ticket)
                mutable.value =
                    mutable.value.copy(
                        persistence =
                            if (result == ComposerCommit.Committed) ComposerPersistence.Durable
                            else ComposerPersistence.Failed,
                    )
        }
    }

    private fun put(
        key: String,
        value: ComposerEntry,
        receiptMessages: Map<String, ComposerMessagePreview> = mutable.value.receiptMessages,
    ) {
        val journal = mutable.value.journal ?: return
        val value = if (journal.format >= 3) value.copy(text = "") else value
        val entries =
            if (
                value.text.isEmpty() &&
                    value.pending == null &&
                    value.receipt == null &&
                    value.createdThreadId == null &&
                    value.recovery == null
            )
                journal.entries - key
            else journal.entries + (key to value)
        replace(journal.copy(entries = entries), receiptMessages = receiptMessages)
    }

    private fun restoreJournal() {
        if (mutable.value.journal != null || restoring?.isActive == true) return
        mutable.value = mutable.value.copy(persistence = ComposerPersistence.Loading)
        restoring = localScope.launch {
            try {
                val saved = store.load(identity)
                if (connections.none { it.current() }) return@launch
                val restored = saved.journal.withServerDrafts().restoreDraftsWithoutReplaying()
                mutable.value =
                    mutable.value.copy(
                        journal = restored,
                        persistence =
                            if (saved.durable) ComposerPersistence.Durable
                            else ComposerPersistence.Failed,
                    )
                if (restored != saved.journal && saved.journal != ComposerJournal())
                    replace(restored)
                val accepted = restored.acceptedNewChats()
                connections
                    .filter { it.current() }
                    .forEach { it.chatList?.retainAcceptedNewChats(accepted, restored = true) }
                connections
                    .firstOrNull { it.current() && it.service.attachmentService != null }
                    ?.let { connection ->
                        store.pruneAttachmentCache(
                            identity,
                            restored.drafts.values
                                .flatMap { draft ->
                                    draft.attachments.map { it.key }
                                }
                                .toSet(),
                        )
                        resumeAttachmentUploads(connection)
                    }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (connections.any { it.current() })
                    mutable.value = mutable.value.copy(persistence = ComposerPersistence.Failed)
            }
        }
    }

    fun open(connection: Connection, target: ComposerTarget): Job? {
        if (!connection.current()) return null
        openedTarget = target
        restoreJournal()
        if (target.threadId == null && contextJob?.isActive != true) {
            contextConnection = connection
            mutable.value = mutable.value.copy(context = ComposerContext.Loading)
            contextJob =
                connection.scope.launch {
                    try {
                        val ready = connection.service.newChatReady()
                        currentCoroutineContext().ensureActive()
                        restoring?.join()
                        if (connection.current()) {
                            mutable.value =
                                mutable.value.copy(
                                    context =
                                        if (ready) ComposerContext.Ready
                                        else ComposerContext.Unavailable,
                                )
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        if (connection.current()) {
                            report(connection, error)
                            mutable.value =
                                mutable.value.copy(
                                    context =
                                        if (error is ApiFailure.Network)
                                            ComposerContext.NetworkFailed
                                        else ComposerContext.Failed,
                                )
                        }
                    }
                }
        }
        return connection.scope.launch {
            restoring?.join()
            if (target.threadId == null) contextJob?.join()
            if (connection.current() && mutable.value.journal != null) {
                val server =
                    if (target.threadId != null || mutable.value.context == ComposerContext.Ready)
                        ServerDraftTarget(target.threadId)
                    else null
                server?.let { synchronize(connection, it, refresh = true)?.join() }
            }
        }
    }

    suspend fun prefillNew(connection: Connection, prefix: String): ComposerPrefillResult {
        val target = ComposerTarget()
        open(connection, target)?.join() ?: return ComposerPrefillResult.Unavailable
        val key = ServerDraftTarget().key
        // Joining a draft read can also start a follow-up refresh queued while it was in flight.
        while (true) {
            val job = draftWork[key]?.job ?: break
            job.join()
        }
        val state = mutable.value
        if (
            !connection.current() ||
                state.journal == null ||
                state.entry(target).pending != null ||
                target.key in state.busy
        )
            return ComposerPrefillResult.Unavailable
        if (
            state.context == ComposerContext.NetworkFailed ||
                state.context == ComposerContext.Ready &&
                    state.synchronization[key] == ComposerSync.NetworkFailed
        )
            return ComposerPrefillResult.NetworkFailed
        if (
            state.context != ComposerContext.Ready ||
                state.synchronization[key] != ComposerSync.Saved
        )
            return ComposerPrefillResult.Unavailable
        beginNew(connection, null)
        val text = mutable.value.entry(target).text
        val command = prefix.trimEnd()
        val existing = text.trimStart()
        val alreadyPrefilled =
            existing.startsWith(command) &&
                (existing.length == command.length || existing[command.length].isWhitespace())
        if (!alreadyPrefilled) edit(connection, target, prefix + text)
        return ComposerPrefillResult.Ready
    }

    fun edit(connection: Connection, target: ComposerTarget, text: String) {
        if (!connection.current() || mutable.value.journal == null) return
        val key = mutable.value.draftKey(target)
        val journal = mutable.value.journal ?: return
        val old = journal.drafts[key] ?: EditableComposerDraft()
        if (old.text == text) return
        replace(
            journal.copy(
                drafts =
                    journal.drafts +
                        (key to
                            old.copy(
                                text = text,
                                dirty = true,
                                revision = old.revision + 1,
                                source = target.key,
                            )),
            ),
        )
        serverTarget(key)?.let { synchronize(connection, it) }
    }

    fun addAttachments(
        connection: Connection,
        draftKey: String,
        source: String,
        uris: List<Uri>,
        replacing: String? = null,
    ) {
        if (!connection.current() || connection.service.attachmentService == null) return
        val contentUris = uris.filter { it.scheme == "content" }
        if (contentUris.isEmpty()) return
        val selection = PendingAttachmentSelection(draftKey, source)
        connection.scope.launch(start = CoroutineStart.UNDISPATCHED) {
            val initial = mutable.value
            mutable.value =
                initial.copy(
                    readingAttachmentSelections = initial.readingAttachmentSelections + selection,
                )
            try {
                restoreJournal()
                restoring?.join()
                if (!connection.current()) return@launch
                val selected = store.readAttachmentMetadata(contentUris)
                // Publish picker results for the same draft in selection order.
                uiState.first { state ->
                    val key = selection.destination(state.journal)
                    state.readingAttachmentSelections.firstOrNull {
                        it.destination(state.journal) == key
                    } === selection
                }
                if (!connection.current()) return@launch
                val journal = mutable.value.journal ?: return@launch
                val key = selection.destination(journal)
                val draft = journal.drafts[key] ?: EditableComposerDraft()
                val old = draft.attachments
                val fresh = selected.map { it.second }
                val attachments =
                    if (replacing == null) old + fresh
                    else {
                        val index = old.indexOfFirst { it.key == replacing }
                        if (index < 0) return@launch
                        old.take(index) + fresh + old.drop(index + 1)
                    }
                putAttachments(connection, key, draft.copy(source = source), attachments)
                replacing?.let(::discardAttachment)
                selected.forEach { (uri, attachment) ->
                    startAttachment(connection, attachment, uri)
                }
            } finally {
                val state = mutable.value
                mutable.value =
                    state.copy(
                        readingAttachmentSelections = state.readingAttachmentSelections - selection,
                    )
            }
        }
    }

    fun removeAttachment(connection: Connection, key: String) {
        if (!connection.current()) return
        val (draftKey, draft) = attachmentDraft(key) ?: return
        putAttachments(connection, draftKey, draft, draft.attachments.filterNot { it.key == key })
        discardAttachment(key)
    }

    fun retryAttachment(connection: Connection, key: String) {
        if (!connection.current() || key in attachmentJobs) return
        val attachment = attachmentDraft(key)?.value?.attachments?.firstOrNull { it.key == key }
        if (attachment?.failure == AttachmentFailure.UploadFailed) {
            val reset = updateAttachment(connection, key) { it.copy(failure = null) } ?: return
            startAttachment(connection, reset)
        }
    }

    private fun attachmentDraft(key: String): Map.Entry<String, EditableComposerDraft>? =
        mutable.value.journal?.drafts?.entries?.firstOrNull { (_, draft) ->
            draft.attachments.any { it.key == key }
        }

    private fun putAttachments(
        connection: Connection,
        draftKey: String,
        draft: EditableComposerDraft,
        attachments: List<DraftChatAttachment>,
    ) {
        val journal = mutable.value.journal ?: return
        replace(
            journal.copy(
                drafts =
                    journal.drafts +
                        (draftKey to
                            draft.copy(
                                attachments = attachments,
                                dirty = true,
                                revision = draft.revision + 1,
                            )),
            ),
        )
        if (attachments.all { it.reference != null })
            serverTarget(draftKey)?.let { synchronize(connection, it) }
    }

    private fun updateAttachment(
        connection: Connection,
        key: String,
        transform: (DraftChatAttachment) -> DraftChatAttachment,
    ): DraftChatAttachment? {
        if (!connection.current()) return null
        val (draftKey, draft) = attachmentDraft(key) ?: return null
        val updated = transform(draft.attachments.first { it.key == key })
        putAttachments(
            connection,
            draftKey,
            draft,
            draft.attachments.map {
                if (it.key == key) updated else it
            },
        )
        return updated
    }

    private fun discardAttachment(key: String) {
        val work = attachmentJobs.remove(key)?.second
        work?.cancel()
        setAttachmentProgress(key, null)
        localScope.launch {
            work?.join()
            withContext(Dispatchers.IO) { attachmentFile(key).delete() }
        }
    }

    private fun resumeAttachmentUploads(connection: Connection) {
        if (!connection.current()) return
        mutable.value.journal?.drafts?.values?.forEach { draft ->
            draft.attachments.forEach { startAttachment(connection, it) }
        }
    }

    private fun setAttachmentProgress(key: String, percent: Int?) {
        val state = mutable.value
        if (state.attachmentProgress[key] == percent) return
        mutable.value =
            state.copy(
                attachmentProgress =
                    if (percent == null) state.attachmentProgress - key
                    else state.attachmentProgress + (key to percent),
            )
    }

    private fun startAttachment(
        connection: Connection,
        attachment: DraftChatAttachment,
        source: Uri? = null,
    ) {
        val service = connection.service.attachmentService ?: return
        val key = attachment.key
        if (attachment.reference != null || attachment.failure != null || key in attachmentJobs)
            return
        val job =
            connection.scope.launch(start = CoroutineStart.LAZY) {
                val self = checkNotNull(currentCoroutineContext()[Job])
                fun current() = attachmentJobs[key]?.second === self && connection.current()
                try {
                    val file = attachmentFile(key)
                    val size = attachmentSlots.withPermit {
                        if (!current()) return@launch
                        when {
                            source != null ->
                                store.contentResolver.stageChatAttachment(source, file)
                            else ->
                                withContext(Dispatchers.IO) {
                                    if (!file.isFile) throw AttachmentSourceUnavailable()
                                    file.length()
                                }
                        }
                    }
                    if (size > MaxChatAttachmentBytes) throw AttachmentTooLarge()
                    if (!current()) return@launch
                    val staged =
                        updateAttachment(connection, key) { it.copy(staged = true, size = size) }
                            ?: return@launch
                    val progress = MutableStateFlow<Int?>(null)
                    val observer = launch {
                        progress.collect { if (current()) setAttachmentProgress(key, it) }
                    }
                    try {
                        var failures = 0
                        while (current()) {
                            try {
                                val reference = attachmentSlots.withPermit {
                                    if (!current()) return@launch
                                    progress.value = 0
                                    service.uploadChatAttachment(file, staged) { bytes ->
                                        progress.value =
                                            if (size == 0L) 100
                                            else ((bytes.coerceIn(0, size) * 100) / size).toInt()
                                    }
                                }
                                if (current())
                                    updateAttachment(connection, key) {
                                        it.copy(reference = reference)
                                    }
                                break
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (error: Exception) {
                                val wait = uploadRetryDelay(error)
                                if (wait == null || failures == ChatDependencyRetryCount)
                                    throw error
                                failures++
                                progress.value = null
                                delay(wait)
                            }
                        }
                    } finally {
                        observer.cancel()
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (current()) {
                        updateAttachment(connection, key) {
                            it.copy(
                                failure =
                                    when (error) {
                                        is AttachmentTooLarge -> AttachmentFailure.TooLarge
                                        is AttachmentSourceUnavailable ->
                                            AttachmentFailure.SourceUnavailable
                                        else -> AttachmentFailure.UploadFailed
                                    },
                            )
                        }
                        report(connection, error)
                    }
                } finally {
                    if (attachmentJobs[key]?.second === self) {
                        attachmentJobs.remove(key)
                        setAttachmentProgress(key, null)
                    }
                }
            }
        attachmentJobs[key] = connection to job
        job.start()
    }

    private fun uploadRetryDelay(error: Exception): Long? =
        when (error) {
            is AttachmentStorageRejection -> uploadRetryDelay(error.response)
            is IOException,
            is ApiFailure.Network -> ChatDependencyRetryDelayMillis
            is ApiFailure.Http ->
                if (error.status in 500..599 || error.status in setOf(408, 425, 429))
                    retryAfterDelayMillis(error.retryAfterSeconds) ?: ChatDependencyRetryDelayMillis
                else null
            else -> null
        }

    fun restoreDraft(connection: Connection, target: ComposerTarget, key: String) {
        val journal = mutable.value.journal ?: return
        val draftKey = mutable.value.draftKey(target)
        val draft = journal.drafts[draftKey] ?: EditableComposerDraft()
        if (
            !connection.current() ||
                !key.canRestoreIn(target) ||
                draft.text.isNotEmpty() ||
                draft.attachments.isNotEmpty()
        )
            return
        val text = journal.retainedDrafts[key] ?: return
        val choices = if (draftKey == "new:") journal.retainedDraftConnectorOverrides[key] else null
        replace(
            journal.copy(
                retainedDrafts = journal.retainedDrafts - key,
                retainedDraftAttachments = journal.retainedDraftAttachments - key,
                newChatConnectorOverrides = choices ?: journal.newChatConnectorOverrides,
                retainedDraftConnectorOverrides = journal.retainedDraftConnectorOverrides - key,
                newChatModel =
                    if (draftKey == "new:" && key in journal.retainedDraftModels)
                        journal.retainedDraftModels[key]
                    else journal.newChatModel,
                retainedDraftModels = journal.retainedDraftModels - key,
                drafts =
                    journal.drafts +
                        (draftKey to
                            draft.copy(
                                text = text,
                                attachments =
                                    journal.retainedDraftAttachments[key].orEmpty().map {
                                        it.restoredAttachment()
                                    },
                                dirty = true,
                                revision = draft.revision + 1,
                                source = target.key,
                            )),
            ),
        )
        serverTarget(draftKey)?.let { synchronize(connection, it) }
    }

    private fun serverTarget(key: String): ServerDraftTarget? =
        when {
            key.startsWith("thread:") -> ServerDraftTarget(key.removePrefix("thread:"))
            key == "new:" -> ServerDraftTarget()
            else -> null
        }

    private fun syncStatus(key: String, status: ComposerSync) {
        mutable.value =
            mutable.value.copy(synchronization = mutable.value.synchronization + (key to status))
    }

    /**
     * One serialized read/write worker per canonical target; newer edits never cancel an in-flight
     * PATCH.
     */
    private fun synchronize(
        connection: Connection,
        target: ServerDraftTarget,
        refresh: Boolean = false,
    ): Job? {
        if (
            !connection.current() ||
                target.threadId == null && mutable.value.context != ComposerContext.Ready
        )
            return null
        draftWork[target.key]?.let {
            it.refresh = it.refresh || refresh
            return it.job
        }
        if (!refresh && mutable.value.synchronization[target.key] == ComposerSync.Unsupported)
            return null
        val work = DraftWork(connection, target)
        draftWork[target.key] = work
        work.job =
            connection.scope.launch {
                fun current() = connection.current() && draftWork[target.key] === work
                try {
                    var journal = mutable.value.journal ?: return@launch
                    if (refresh || target.key !in readableDrafts) {
                        val before = journal.drafts[target.key] ?: EditableComposerDraft()
                        readableDrafts.remove(target.key)
                        syncStatus(target.key, ComposerSync.Loading)
                        val list = connection.chatList
                        val indexVersion = list?.draftIndexRequestVersion
                        val remote =
                            ChatDependencyRetry()
                                .read(isCurrent = ::current) {
                                    connection.service.composerDraft(target)
                                }
                                .editableContent()
                        currentCoroutineContext().ensureActive()
                        if (!current()) return@launch
                        if (remote == null) {
                            syncStatus(target.key, ComposerSync.Unsupported)
                            return@launch
                        }
                        if (target.threadId != null && indexVersion != null)
                            list.confirmDraftPresence(
                                target.threadId,
                                !remote.text.isBlankWebDraft() || remote.attachments.isNotEmpty(),
                                indexVersion,
                            )
                        readableDrafts += target.key
                        journal = mutable.value.journal ?: return@launch
                        val local = journal.drafts[target.key] ?: EditableComposerDraft()
                        val localReferences = local.attachments.map { it.reference }
                        if (
                            !local.dirty &&
                                local.revision == before.revision &&
                                (local.text != remote.text || localReferences != remote.attachments)
                        ) {
                            val unmatched =
                                local.attachments
                                    .groupBy { it.reference }
                                    .mapValues { (_, files) ->
                                        ArrayDeque(files)
                                    }
                            val attachments =
                                remote.attachments.map { reference ->
                                    unmatched[reference]?.removeFirstOrNull()
                                        ?: reference.restoredAttachment()
                                }
                            replace(
                                journal.copy(
                                    drafts =
                                        journal.drafts +
                                            (target.key to
                                                local.copy(
                                                    text = remote.text,
                                                    attachments = attachments,
                                                )),
                                ),
                            )
                            unmatched.values.flatten().forEach { discardAttachment(it.key) }
                        }
                        val opened = openedTarget
                        if (
                            opened != null &&
                                !local.dirty &&
                                local.revision == before.revision &&
                                remote.text.isEmpty() &&
                                remote.attachments.isEmpty() &&
                                mutable.value.draftKey(opened) == target.key &&
                                mutable.value.entry(opened).pending == null &&
                                mutable.value.readingAttachmentSelections.none {
                                    it.destination(journal) == target.key
                                }
                        )
                            journal.compatibleDraftKey(opened)?.let {
                                restoreDraft(connection, opened, it)
                            }
                    }
                    while (current()) {
                        val draft = mutable.value.journal?.drafts?.get(target.key) ?: break
                        if (!draft.dirty) break
                        val attachments = draft.attachments.mapNotNull { it.reference }
                        if (attachments.size != draft.attachments.size) {
                            syncStatus(target.key, ComposerSync.Idle)
                            return@launch
                        }
                        syncStatus(target.key, ComposerSync.Saving)
                        // Web flushes explicit clears immediately; ordinary edits use its 500ms
                        // debounce.
                        if (
                            (draft.text.isNotEmpty() || draft.attachments.isNotEmpty()) &&
                                withTimeoutOrNull(500) {
                                    uiState.first { it.journal?.drafts?.get(target.key) != draft }
                                } != null
                        )
                            continue
                        val latest = mutable.value.journal?.drafts?.get(target.key) ?: break
                        if (latest != draft) continue
                        val saved = store.load(identity)
                        currentCoroutineContext().ensureActive()
                        if (!current()) return@launch
                        if (mutable.value.journal?.drafts?.get(target.key) != draft) continue
                        if (!saved.durable || saved.journal.drafts[target.key] != draft)
                            throw IOException("Draft is not durable")
                        var failures = 0
                        while (
                            current() && mutable.value.journal?.drafts?.get(target.key) == draft
                        ) {
                            try {
                                if (attachments.isEmpty())
                                    connection.service.saveComposerDraft(target, draft.text)
                                else {
                                    val service =
                                        connection.service.attachmentService ?: return@launch
                                    service.saveAttachmentDraft(target, draft.text, attachments)
                                }
                                break
                            } catch (error: ApiFailure) {
                                if (
                                    mutable.value.journal?.drafts?.get(target.key) != draft &&
                                        error.boundedApiRetryDelayMillis(0) != null
                                )
                                    break
                                val wait =
                                    error.boundedApiRetryDelayMillis(failures++) ?: throw error
                                withTimeoutOrNull(wait) {
                                    uiState.first { it.journal?.drafts?.get(target.key) != draft }
                                }
                            }
                        }
                        currentCoroutineContext().ensureActive()
                        if (!current()) return@launch
                        if (mutable.value.journal?.drafts?.get(target.key) != draft) continue
                        target.threadId?.let {
                            connection.chatList?.confirmDraftPresence(
                                it,
                                draft.hasContent,
                            )
                        }
                        journal = mutable.value.journal ?: return@launch
                        if (journal.drafts[target.key] == draft)
                            replace(
                                journal.copy(
                                    drafts =
                                        journal.drafts + (target.key to draft.copy(dirty = false)),
                                ),
                            )
                    }
                    if (current()) syncStatus(target.key, ComposerSync.Saved)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (current()) {
                        report(connection, error)
                        syncStatus(
                            target.key,
                            if (error is ApiFailure.Network) ComposerSync.NetworkFailed
                            else ComposerSync.Failed,
                        )
                    }
                } finally {
                    if (draftWork[target.key] === work) {
                        draftWork.remove(target.key)
                        if (work.refresh && connection.current())
                            synchronize(connection, target, refresh = true)
                    }
                }
            }
        return work.job
    }

    fun beginNew(connection: Connection, projectId: String?) {
        if (!connection.current()) return
        val target = ComposerTarget(projectId = projectId)
        val old = mutable.value.entry(target)
        if (old.createdThreadId != null) put(target.key, old.copy(createdThreadId = null))
    }

    fun editConnectorOverride(
        connection: Connection,
        target: ComposerTarget,
        choice: ChatConnectorOverride?,
    ) {
        val state = mutable.value
        val journal = state.journal ?: return
        if (
            !connection.current() ||
                connection.connectors == null ||
                !state.canEditDraftConnectors(target)
        )
            return
        val pending = journal.entries[target.key]?.pending
        val previous = state.connectorOverrides(target)
        val choices =
            when {
                choice != null ->
                    previous.filterNot { it.connectionId == choice.connectionId } + choice
                pending != null -> previous.map { it.copy(enabled = null) }
                else -> emptyList()
            }
        if (choices == previous) return
        // Once the thread exists, reset has to clear even preferences already applied by this send.
        if (pending == null)
            replace(
                journal.copy(
                    format = CONNECTOR_DRAFT_JOURNAL_FORMAT,
                    newChatConnectorOverrides = choices,
                ),
            )
        else updatePending(target.key, pending.copy(connectorOverrides = choices))
    }

    fun acknowledge(connection: Connection, threadId: String) {
        if (!connection.current()) return
        val journal = mutable.value.journal ?: return
        journal.entries
            .filterValues { it.createdThreadId == threadId }
            .forEach { (key, entry) -> put(key, entry.copy(createdThreadId = null)) }
    }

    private fun checkingTargets() =
        operations.values.filter { it.checking }.mapTo(hashSetOf()) { it.key }

    private fun begin(
        connection: Connection,
        key: String,
        checking: Boolean = false,
        recovery: Pair<RecoverySelection, RecoveryOperationPhase>? = null,
    ): Operation? {
        if (!connection.current() || mutable.value.journal == null) return null
        operations[key]?.let { previous ->
            // A previous accepted input's replaceable read never owns the next user send.
            if (
                !checking &&
                    previous.checking &&
                    mutable.value.journal?.entries?.get(key)?.pending == null
            ) {
                operations.remove(key)
                previous.job?.cancel()
            } else return null
        }
        return Operation(key, connection, checking, recovery).also {
            operations[key] = it
            mutable.value =
                mutable.value.copy(
                    busy = operations.keys.toSet(),
                    checking = checkingTargets(),
                    recovering =
                        recovery?.let { mutable.value.recovering + it } ?: mutable.value.recovering,
                    recoveryFailures = mutable.value.recoveryFailures - key,
                    failed = mutable.value.failed - key,
                    unobserved = mutable.value.unobserved - key,
                )
        }
    }

    fun editDraftModel(
        connection: Connection,
        target: ComposerTarget,
        selection: DraftModelSelection,
    ) {
        val state = mutable.value
        val journal = state.journal ?: return
        if (
            !connection.current() ||
                !state.canEditDraftModel(target) ||
                journal.newChatModel == selection
        )
            return
        replace(journal.copy(newChatModel = selection))
    }

    fun send(connection: Connection, target: ComposerTarget, options: DefaultModelOptions? = null) {
        if (!mutable.value.canSend(target) || !connection.current()) return
        val op = begin(connection, target.key) ?: return
        val journal = checkNotNull(mutable.value.journal)
        val entry = mutable.value.entry(target)
        val draftKey = mutable.value.draftKey(target)
        val draft = journal.drafts[draftKey] ?: EditableComposerDraft()
        val attachments = draft.attachments.map { checkNotNull(it.reference) }
        val hasText = !entry.text.isBlankWebDraft()
        val threadId = target.threadId ?: UUID.randomUUID().toString()
        val eventId = UUID.randomUUID().toString()
        val draftModel = journal.newChatModel.takeIf { target.threadId == null }
        val pending =
            PendingText(
                eventId,
                threadId,
                if (target.threadId == null)
                    CreateThreadRequest(
                            projectId = target.projectId,
                            clientThreadId = threadId,
                            eventId = UUID.randomUUID().toString(),
                        )
                        .let { request ->
                            draftModel?.applyTo(request, options) ?: request
                        }
                else null,
                SendRequestVariant1(
                    prompt = if (hasText) entry.text else AttachmentOnlyPrompt,
                    threadId = threadId,
                    clientEventId = eventId,
                    chatThreadSortEventId = UUID.randomUUID().toString(),
                    hasTextContent = hasText,
                    userMessage =
                        SendRequestVariant1UserMessage(
                            CanonicalInteger1,
                            buildList {
                                if (hasText)
                                    add(
                                        SendRequestVariant1UserMessagePartsItemVariant1(
                                            SendRequestVariant1UserMessagePartsItemVariant1Type
                                                .TEXT,
                                            entry.text,
                                        ),
                                    )
                                attachments.forEach { add(it.part()) }
                            },
                        ),
                ),
                TextStage.Prepared,
                connectorOverrides =
                    if (target.threadId == null) journal.newChatConnectorOverrides else emptyList(),
                started = store.sendClock.markNow(),
                draftModel = draftModel,
                attachmentReferences = attachments,
                attachmentFiles =
                    draft.attachments
                        .filter { it.staged }
                        .associate {
                            checkNotNull(it.reference).id to attachmentFile(it.key)
                        },
            )
        replace(
            journal.copy(
                entries =
                    journal.entries +
                        (op.key to entry.copy(text = "", pending = pending, receipt = null)),
                newChatConnectorOverrides =
                    if (pending.create != null) emptyList() else journal.newChatConnectorOverrides,
                newChatModel = journal.newChatModel.takeIf { pending.create == null },
                drafts =
                    journal.drafts +
                        (draftKey to
                            draft.copy(
                                text = "",
                                attachments = emptyList(),
                                dirty = true,
                                revision = draft.revision + 1,
                                source = target.key,
                            )),
            ),
        )
        serverTarget(draftKey)?.let { synchronize(connection, it) }
        dispatch(op)
    }

    /** Explicit user recovery always reuses the frozen request and all original UUIDs. */
    fun retry(connection: Connection, target: ComposerTarget) {
        val state = mutable.value
        val pending = state.entry(target).pending ?: return
        if (pending.started != null && !state.connectorSetupFailed(target.key)) return
        begin(connection, target.key)?.let(::dispatch)
    }

    private suspend fun durableRecovery(op: Operation, attempt: ComposerRecovery) {
        val saved = store.load(identity)
        requireCurrent(op)
        if (
            !saved.durable ||
                saved.journal.entries[op.key]?.recovery != attempt ||
                mutable.value.journal?.entries?.get(op.key)?.recovery != attempt
        )
            throw IOException("Exact recovery intent is not durable")
    }

    private fun prepareRecovery(op: Operation, attempt: ComposerRecovery) {
        val entry = mutable.value.journal?.entries?.get(op.key) ?: ComposerEntry()
        put(op.key, entry.copy(recovery = attempt))
        if (attempt.reset != null && attempt.reset != entry.recovery?.reset)
            op.unsentReset = UnsentReset(entry.recovery, attempt)
    }

    private fun restoreUnsentReset(op: Operation) {
        val unsent = op.unsentReset ?: return
        op.unsentReset = null
        val entry = mutable.value.journal?.entries?.get(op.key) ?: return
        if (entry.recovery == unsent.prepared) put(op.key, entry.copy(recovery = unsent.previous))
    }

    fun recover(
        connection: Connection,
        target: ComposerTarget,
        failureId: String,
        reset: Boolean,
        confirmedAccount: String? = null,
        originalResetKey: String? = null,
    ) {
        val recovery = connection.recovery ?: return
        val selected =
            recovery.selection()?.takeIf {
                it.failureId == failureId && it.threadId == target.threadId
            } ?: return
        val state = mutable.value
        if (
            state.journal == null ||
                state.persistence == ComposerPersistence.Failed ||
                state.entry(target).pending != null
        )
            return
        val previous = state.entry(target).recovery
        val generation = recovery.generation
        val displayed = recovery.uiState.value.data?.takeIf { it.selection == selected }
        val expectedAccount =
            previous?.takeIf { it.selection == selected && it.outcome == null }?.reset?.accountId
                ?: displayed?.resetAccount?.id
        if (reset && expectedAccount == null) return
        if (confirmedAccount != null && expectedAccount != confirmedAccount) return
        val unconfirmed = previous?.takeIf { it.outcome == null }?.reset
        if (confirmedAccount != null && unconfirmed != null) return
        if (originalResetKey != null && unconfirmed?.idempotencyKey != originalResetKey) return
        if (previous?.submitted == true && previous.selection == selected) return
        if (previous?.reset != null && previous.outcome == null && previous.selection != selected)
            return
        val phase =
            if (reset && unconfirmed != null) RecoveryOperationPhase.CheckingReset
            else RecoveryOperationPhase.Preparing
        val op = begin(connection, target.key, recovery = selected to phase) ?: return
        op.job =
            connection.scope.launch {
                try {
                    val data = recovery.validate(selected, generation)
                    requireCurrent(op)
                    if (!data.classification.canContinue) throw RecoveryUnavailable()
                    if (reset && data.account?.id != expectedAccount) throw RecoveryUnavailable()
                    var attempt =
                        mutable.value.entry(target).recovery?.takeIf { it.selection == selected }
                    if (
                        attempt?.reset != null &&
                            attempt.outcome != null &&
                            attempt.reset.accountId != data.account?.id
                    ) {
                        // The previous reset is settled and no input was dispatched. A fresh
                        // displayed account choice starts its own intent, never inherits that
                        // reset.
                        if (displayed == null || displayed.account?.id != data.account?.id)
                            throw RecoveryUnavailable()
                        attempt = null
                    }
                    if (attempt == null) {
                        if (reset && data.resetAccount == null) throw RecoveryUnavailable()
                        attempt = newRecovery(data, reset)
                        prepareRecovery(op, attempt)
                    } else if (
                        reset &&
                            (attempt.reset == null ||
                                attempt.outcome == ResetSubscriptionResultOutcome.NOCREDIT)
                    ) {
                        // A new explicit choice is safe before input dispatch when no reset was
                        // attempted or noCredit definitively spent nothing. Keep the input UUIDs.
                        if (data.resetAccount == null) throw RecoveryUnavailable()
                        attempt = attempt.copy(reset = newRecoveryReset(data), outcome = null)
                        prepareRecovery(op, attempt)
                    }
                    durableRecovery(op, attempt)
                    val resetIntent = attempt.reset
                    if (resetIntent != null && attempt.outcome == null) {
                        if (
                            !reset ||
                                data.account?.id != resetIntent.accountId ||
                                data.classification.kind != FailureKind.Usage ||
                                data.classification.framework != RecoveryFramework.Codex ||
                                data.classification.limit == RecoveryLimit.Model
                        )
                            throw RecoveryUnavailable()
                        recovery.requireWritable(selected, generation)
                        // From this call onward the outcome may be unknown. Never restore the
                        // previous intent after a reset could have reached the provider.
                        op.unsentReset = null
                        val result =
                            recovery.service.resetSubscription(
                                resetIntent.accountId,
                                resetIntent.idempotencyKey,
                            )
                        requireCurrent(op)
                        attempt = attempt.copy(outcome = result.outcome)
                        put(op.key, mutable.value.entry(target).copy(recovery = attempt))
                        durableRecovery(op, attempt)
                    }
                    if (reset && attempt.outcome == ResetSubscriptionResultOutcome.NOCREDIT)
                        return@launch
                    val current = recovery.validate(selected, generation)
                    requireCurrent(op)
                    if (
                        !current.classification.canContinue ||
                            mutable.value.entry(target).pending != null ||
                            attempt.reset != null && current.account?.id != attempt.reset.accountId
                    )
                        throw RecoveryUnavailable()
                    val pending =
                        PendingText(
                            checkNotNull(attempt.send.clientEventId),
                            selected.threadId,
                            null,
                            attempt.send,
                            TextStage.Prepared,
                        )
                    put(op.key, mutable.value.entry(target).copy(pending = pending, receipt = null))
                    deliver(op, selected, generation)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    fail(op, error)
                } finally {
                    finish(op)
                }
            }
    }

    fun reconcileRecovery(connection: Connection, checkpoint: HistoryCheckpoint) {
        if (!connection.current()) return
        val key = "thread:${checkpoint.threadId}"
        val entry = mutable.value.journal?.entries?.get(key) ?: return
        val recovery = entry.recovery ?: return
        if (!recovery.submitted || entry.pending != null) return
        val id = recovery.send.clientEventId
        if (checkpoint.rows.any { it.id == id || it.revokesId == id })
            put(key, entry.copy(recovery = null))
    }

    fun reconcileMessages(
        connection: Connection,
        threadId: String,
        transcript: HistoryTranscript,
    ) {
        if (!connection.current()) return
        val state = mutable.value
        val matched =
            state.receiptMessages.values
                .filter { it.threadId == threadId && transcript.hasSettledInput(it.eventId) }
                .map { it.eventId }
        if (matched.isNotEmpty())
            mutable.value = state.copy(receiptMessages = state.receiptMessages - matched)
        for (op in operations.values.toList()) {
            val pending = mutable.value.journal?.entries?.get(op.key)?.pending ?: continue
            if (
                pending.started == null ||
                    pending.threadId != threadId ||
                    pending.eventId !in transcript.persistedIds ||
                    !current(op)
            )
                continue
            settle(op, pending, TextDisposition.Accepted, transcript = transcript)
            finish(op)
            op.job?.cancel()
        }
    }

    private fun resumeSends(connection: Connection) {
        val state = mutable.value
        state.journal?.entries?.forEach { (key, entry) ->
            if (
                entry.pending?.started != null &&
                    key !in operations &&
                    !state.connectorSetupFailed(key)
            )
                begin(connection, key)?.let(::dispatch)
        }
    }

    private suspend fun durable(op: Operation, pending: PendingText) {
        val saved = store.load(identity)
        requireCurrent(op)
        if (
            !saved.durable ||
                saved.journal.entries[op.key]?.pending != pending ||
                mutable.value.journal?.entries?.get(op.key)?.pending != pending
        )
            throw IOException("Exact pending input is not durable")
    }

    private fun stage(op: Operation, pending: PendingText, stage: TextStage): PendingText =
        pending.copy(stage = stage).also { updatePending(op.key, it) }

    private fun updatePending(key: String, pending: PendingText) {
        val state = mutable.value
        val journal = checkNotNull(state.journal)
        val entry = checkNotNull(journal.entries[key])
        check(entry.pending?.eventId == pending.eventId)
        val next = entry.copy(pending = pending)
        if (pending.started == null) put(key, next)
        else {
            mutable.value =
                state.copy(journal = journal.copy(entries = journal.entries + (key to next)))
        }
    }

    private fun dispatch(op: Operation) {
        op.job =
            op.connection.scope.launch {
                try {
                    val pending = checkNotNull(mutable.value.journal?.entries?.get(op.key)?.pending)
                    if (pending.started == null) deliver(op) else deliverAutomatically(op)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    fail(op, error)
                } finally {
                    finish(op)
                }
            }
    }

    private suspend fun deliverAutomatically(op: Operation) {
        var failures = 0
        val first = checkNotNull(mutable.value.journal?.entries?.get(op.key)?.pending)
        op.connection.chatList?.showOutgoingActivity(first)
        while (true) {
            requireCurrent(op)
            val pending = checkNotNull(mutable.value.journal?.entries?.get(op.key)?.pending)
            var retryAfterSeconds: Long? = null
            try {
                if (pending.stage == TextStage.Sending) {
                    val observed =
                        op.connection.service.observeInput(pending.threadId, pending.eventId)
                    requireCurrent(op)
                    if (
                        observed.threadId != pending.threadId || observed.eventId != pending.eventId
                    )
                        throw ApiFailure.IncompatibleResponse()
                    observed.disposition?.let {
                        settle(op, pending, it, sequence = observed.sequence)
                        return
                    }
                }
                // The event retention sweep may remove the write's deduplication evidence at 30
                // days.
                if (checkNotNull(pending.started).elapsedNow() < 30.days) {
                    var sending = pending
                    val create = pending.create
                    if (
                        create != null &&
                            pending.stage in setOf(TextStage.Prepared, TextStage.Creating)
                    ) {
                        sending = stage(op, pending, TextStage.Creating)
                        val created = op.connection.service.createThread(create)
                        requireCurrent(op)
                        if (created.id != pending.threadId || created.projectId != create.projectId)
                            throw ApiFailure.IncompatibleResponse()
                        sending = stage(op, sending, TextStage.Created)
                    }
                    applyNewChatConnectors(op, sending)
                    sending = stage(op, sending, TextStage.Sending)
                    val receipt = op.connection.service.sendInput(sending.send)
                    requireCurrent(op)
                    if (receipt.threadId != sending.threadId)
                        throw ApiFailure.IncompatibleResponse()
                    settle(op, sending, TextDisposition.Accepted)
                    return
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: ApiFailure) {
                requireCurrent(op)
                if (
                    error is ApiFailure.Unauthenticated ||
                        error is ApiFailure.UpdateRequired ||
                        error is ApiFailure.Http && error.status == 401
                ) {
                    report(op.connection, error)
                    return
                }
                val latest = checkNotNull(mutable.value.journal?.entries?.get(op.key)?.pending)
                if (latest.awaitingConnectorSetup) {
                    fail(op, error)
                    return
                }
                if (
                    error is ApiFailure.Http &&
                        error.status < 500 &&
                        error.status !in setOf(408, 425, 429)
                ) {
                    if (latest.stage == TextStage.Creating) {
                        val entry = checkNotNull(mutable.value.journal?.entries?.get(op.key))
                        val journal = checkNotNull(mutable.value.journal)
                        val choices = latest.connectorOverrides
                        replace(
                            journal.copy(
                                entries = journal.entries + (op.key to entry.copy(pending = null)),
                                retainedDrafts =
                                    journal.retainedDrafts + (latest.eventId to latest.displayText),
                                retainedDraftAttachments =
                                    if (latest.attachmentReferences.isEmpty())
                                        journal.retainedDraftAttachments
                                    else
                                        journal.retainedDraftAttachments +
                                            (latest.eventId to latest.attachmentReferences),
                                retainedDraftModels =
                                    journal.retainedDraftModels +
                                        (latest.eventId to latest.draftModel),
                                retainedDraftConnectorOverrides =
                                    if (choices.isEmpty()) journal.retainedDraftConnectorOverrides
                                    else
                                        journal.retainedDraftConnectorOverrides +
                                            (latest.eventId to choices),
                            ),
                        )
                        deleteSentAttachmentFiles(latest)
                        fail(op, error)
                    } else settle(op, latest, TextDisposition.Rejected)
                    return
                }
                retryAfterSeconds = error.retryAfterSeconds()
            }
            delay(continuousRetryDelayMillis(failures, retryAfterSeconds))
            if (failures < continuousRetryDelays.lastIndex) failures++
        }
    }

    private suspend fun deliver(
        op: Operation,
        validated: RecoverySelection? = null,
        generation: Long? = null,
    ) {
        var pending = checkNotNull(mutable.value.journal?.entries?.get(op.key)?.pending)
        op.inputMayHaveBeenSent = pending.stage == TextStage.Sending
        op.connection.chatList?.showOutgoingActivity(pending)
        val recoveryAttempt =
            mutable.value.journal?.entries?.get(op.key)?.recovery?.takeIf {
                it.send.clientEventId == pending.eventId
            }
        val recoveryGeneration = generation ?: op.connection.recovery?.generation
        if (recoveryAttempt != null) {
            if (pending.stage == TextStage.Sending) {
                val observed = op.connection.service.observeInput(pending.threadId, pending.eventId)
                requireCurrent(op)
                if (observed.threadId != pending.threadId || observed.eventId != pending.eventId)
                    throw ApiFailure.IncompatibleResponse()
                if (observed.disposition != null) {
                    settle(op, pending, observed.disposition, sequence = observed.sequence)
                    return
                }
            }
            val recovery = op.connection.recovery ?: throw RecoveryUnavailable()
            if (validated != recoveryAttempt.selection) {
                val context =
                    recovery.validate(recoveryAttempt.selection, checkNotNull(recoveryGeneration))
                if (
                    !context.classification.canContinue ||
                        recoveryAttempt.reset != null &&
                            context.account?.id != recoveryAttempt.reset.accountId
                )
                    throw RecoveryUnavailable()
            }
            requireCurrent(op)
        }
        if (
            pending.create != null && pending.stage in setOf(TextStage.Prepared, TextStage.Creating)
        ) {
            pending = stage(op, pending, TextStage.Creating)
            durable(op, pending)
            val result = op.connection.service.createThread(checkNotNull(pending.create))
            requireCurrent(op)
            if (result.id != pending.threadId || result.projectId != pending.create.projectId)
                throw ApiFailure.IncompatibleResponse()
            pending = stage(op, pending, TextStage.Created)
        }
        pending = stage(op, pending, TextStage.Sending)
        durable(op, pending)
        recoveryAttempt?.let {
            checkNotNull(op.connection.recovery)
                .requireWritable(it.selection, checkNotNull(recoveryGeneration))
        }
        op.inputMayHaveBeenSent = true
        val result = op.connection.service.sendInput(pending.send)
        requireCurrent(op)
        if (result.threadId != pending.threadId) throw ApiFailure.IncompatibleResponse()
        settle(op, pending, TextDisposition.Accepted)
    }

    private suspend fun applyNewChatConnectors(op: Operation, pending: PendingText) {
        if (!pending.awaitingConnectorSetup) return
        val connectors = op.connection.connectors ?: throw ApiFailure.IncompatibleResponse()
        val memberAccess = connectors.memberAccessEnabled()
        requireCurrent(op)
        if (memberAccess) return
        for (choice in pending.connectorOverrides) {
            connectors.setChatOverride(pending.threadId, choice)
            requireCurrent(op)
        }
    }

    fun observe(connection: Connection, target: ComposerTarget) {
        val entry = mutable.value.entry(target)
        if (entry.pending?.started != null) return
        if (entry.pending == null && entry.receipt?.disposition == TextDisposition.Rejected) return
        val thread = entry.pending?.threadId ?: entry.receipt?.threadId ?: return
        val event = entry.pending?.eventId ?: entry.receipt?.eventId ?: return
        val op = begin(connection, target.key, checking = true) ?: return
        op.job =
            connection.scope.launch {
                try {
                    val observed = connection.service.observeInput(thread, event)
                    requireCurrent(op)
                    if (observed.threadId != thread || observed.eventId != event)
                        throw ApiFailure.IncompatibleResponse()
                    val latest = mutable.value.journal?.entries?.get(op.key) ?: return@launch
                    if (latest.pending?.eventId == event) {
                        if (observed.disposition != null)
                            settle(
                                op,
                                checkNotNull(latest.pending),
                                observed.disposition,
                                sequence = observed.sequence,
                            )
                        else
                            mutable.value =
                                mutable.value.copy(unobserved = mutable.value.unobserved + op.key)
                    } else if (latest.receipt?.eventId == event && observed.disposition != null) {
                        val messages = mutable.value.receiptMessages
                        val preview = messages[event]
                        put(
                            op.key,
                            latest.copy(receipt = TextReceipt(thread, event, observed.disposition)),
                            if (preview == null) messages
                            else
                                messages +
                                    (event to
                                        preview.copy(
                                            disposition = observed.disposition,
                                            sequence = observed.sequence ?: preview.sequence,
                                        )),
                        )
                        connection.accepted(thread)
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    fail(op, error)
                } finally {
                    finish(op)
                }
            }
    }

    private fun settle(
        op: Operation,
        pending: PendingText,
        disposition: TextDisposition,
        transcript: HistoryTranscript? = null,
        sequence: Long? = null,
    ) {
        if (!current(op)) return
        val journal = mutable.value.journal ?: return
        val entry = journal.entries[op.key] ?: return
        if (entry.pending?.eventId != pending.eventId) return
        val destination = "thread:${pending.threadId}"
        if (
            destination != op.key &&
                (journal.drafts[destination]?.hasContent == true ||
                    journal.entries[destination]?.pending != null) == true
        )
            throw ApiFailure.IncompatibleResponse()
        val value =
            entry.copy(
                pending = null,
                receipt = TextReceipt(pending.threadId, pending.eventId, disposition),
                createdThreadId = null,
                recovery =
                    entry.recovery?.let {
                        if (it.send.clientEventId == pending.eventId) it.copy(submitted = true)
                        else it
                    },
            )
        // Retain meaningful input, plus this one delivery receipt; do not accumulate read history.
        val meaningful =
            journal.entries.filterValues {
                it.text.isNotEmpty() ||
                    it.pending != null ||
                    it.createdThreadId != null ||
                    it.recovery != null
            }
        var entries = (meaningful - op.key) + (destination to value)
        if (pending.create != null)
            entries = entries + (op.key to ComposerEntry(createdThreadId = pending.threadId))
        var drafts = journal.drafts
        if (pending.create != null) {
            val source = "new:"
            val draft = drafts[source]
            if (
                draft != null &&
                    draft.source == op.key &&
                    (draft.text.isNotEmpty() || draft.attachments.isNotEmpty())
            ) {
                drafts =
                    drafts +
                        (destination to draft.copy(dirty = true)) +
                        (source to
                            draft.copy(
                                text = "",
                                attachments = emptyList(),
                                dirty = true,
                                revision = draft.revision + 1,
                            ))
            }
        }
        val history = op.connection.history?.uiState?.value
        val canonical =
            transcript ?: history?.takeIf { it.thread?.id == pending.threadId }?.transcript
        val receiptMessages = mutable.value.receiptMessages
        replace(
            journal.copy(entries = entries, drafts = drafts),
            receiptMessages =
                if (canonical?.hasSettledInput(pending.eventId) == true) receiptMessages
                else
                    receiptMessages +
                        (pending.eventId to pending.preview(disposition, sequence = sequence)),
        )
        deleteSentAttachmentFiles(pending)
        if (pending.create != null) {
            synchronize(op.connection, ServerDraftTarget())
            synchronize(op.connection, ServerDraftTarget(pending.threadId))
        }
        val list = op.connection.chatList
        val create = pending.create
        if (create != null) {
            list?.retainAcceptedNewChats(
                listOf(ProvisionalChat(pending.threadId, create.projectId)),
            )
        } else if (disposition == TextDisposition.Rejected) {
            list?.refreshAfterSendFailure(pending, rejected = true)
        } else {
            list?.acknowledgeOutgoingActivity(pending)
        }
        op.connection.accepted(pending.threadId)
        if (disposition == TextDisposition.Accepted)
            op.connection.workflowCatalog?.accepted(pending.send.prompt)
    }

    private fun deleteSentAttachmentFiles(pending: PendingText) {
        if (pending.attachmentFiles.isEmpty()) return
        localScope.launch(Dispatchers.IO) { pending.attachmentFiles.values.forEach { it.delete() } }
    }

    private fun report(connection: Connection, error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            connection.onFailure(error)
    }

    private fun fail(op: Operation, error: Exception) {
        if (current(op)) {
            if (!op.checking) {
                mutable.value.journal?.entries?.get(op.key)?.pending?.let { pending ->
                    val rejected =
                        !op.inputMayHaveBeenSent ||
                            error is ApiFailure.Http && error.status in setOf(400, 403, 404, 422)
                    op.connection.chatList?.refreshAfterSendFailure(pending, rejected)
                }
            }
            if (error is RecoveryUnavailable) {
                val entry = mutable.value.journal?.entries?.get(op.key)
                val pending = entry?.pending
                // Prepared proves no input dispatch began. Retain the recovery/reset identity,
                // but do not strand ordinary editing behind an obsolete unsent input.
                if (
                    pending?.stage == TextStage.Prepared &&
                        pending.eventId == entry.recovery?.send?.clientEventId
                )
                    put(op.key, entry.copy(pending = null))
            }
            report(op.connection, error)
            val state = mutable.value
            val recovery = op.recovery?.first
            mutable.value =
                if (recovery != null && state.journal?.entries?.get(op.key)?.pending == null)
                    state.copy(recoveryFailures = state.recoveryFailures + (op.key to recovery))
                else state.copy(failed = state.failed + op.key)
        }
    }

    private fun finish(op: Operation) {
        if (operations[op.key] === op) {
            restoreUnsentReset(op)
            operations.remove(op.key)
            mutable.value =
                mutable.value.copy(
                    busy = operations.keys.toSet(),
                    checking = checkingTargets(),
                    recovering =
                        op.recovery?.let { mutable.value.recovering - it.first }
                            ?: mutable.value.recovering,
                )
        }
    }
}
