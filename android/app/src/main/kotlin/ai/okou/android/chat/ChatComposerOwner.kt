package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.CanonicalInteger1
import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.ResetSubscriptionResultOutcome
import ai.okou.android.api.generated.SendRequestVariant1
import ai.okou.android.api.generated.SendRequestVariant1UserMessage
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant1
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant1Type
import ai.okou.android.auth.WorkspaceIdentity
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
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
    ) {
        var retired = false

        fun current() = !retired && scope.isActive && authorized()
    }

    private class Operation(
        val key: String,
        val connection: Connection,
        val checking: Boolean = false,
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
    private var revision = 0L

    private class DraftWork(val connection: Connection, val target: ServerDraftTarget) {
        var job: Job? = null
        var refresh = false
    }

    private val draftWork = mutableMapOf<String, DraftWork>()
    private val readableDrafts = mutableSetOf<String>()

    fun attach(connection: Connection) {
        connections += connection
        if (!connection.current()) return
        connection.chatList?.onAcceptedChatMissing = { acknowledge(connection, it) }
        val journal = mutable.value.journal
        if (journal == null) restoreJournal()
        else
            connection.chatList?.retainAcceptedNewChats(journal.acceptedNewChats(), restored = true)
    }

    fun detach(connection: Connection): Boolean {
        connection.chatList?.onAcceptedChatMissing = null
        val retired = draftWork.values.filter { it.connection === connection }.toList()
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
                restoreUnsentReset(op)
                operations.remove(op.key)
                mutable.value =
                    mutable.value.copy(busy = operations.keys.toSet(), checking = checkingTargets())
                op.job?.cancel()
            }
        connections -= connection
        connections
            .firstOrNull { it.current() }
            ?.let { next -> retired.forEach { synchronize(next, it.target, refresh = true) } }
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
        val pending = store.persist(identity, value)
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
                            else ComposerPersistence.Failed
                    )
        }
    }

    private fun put(
        key: String,
        value: ComposerEntry,
        receiptMessages: Map<String, ComposerMessagePreview> = mutable.value.receiptMessages,
    ) {
        val journal = mutable.value.journal ?: return
        val value = if (journal.format == 3) value.copy(text = "") else value
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
        restoring =
            localScope.launch {
                try {
                    val saved = store.load(identity)
                    if (connections.none { it.current() }) return@launch
                    val restored = saved.journal.withServerDrafts()
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
                                        else ComposerContext.Unavailable
                                )
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        if (connection.current()) {
                            report(connection, error)
                            mutable.value = mutable.value.copy(context = ComposerContext.Failed)
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

    suspend fun prefillNew(connection: Connection, prefix: String): Boolean {
        val target = ComposerTarget()
        open(connection, target)?.join() ?: return false
        val key = ServerDraftTarget().key
        // Joining a draft read can also start a follow-up refresh queued while it was in flight.
        while (true) {
            val job = draftWork[key]?.job ?: break
            job.join()
        }
        val state = mutable.value
        if (
            !connection.current() ||
                state.context != ComposerContext.Ready ||
                state.journal == null ||
                state.entry(target).pending != null ||
                target.key in state.busy ||
                state.synchronization[key] != ComposerSync.Saved
        )
            return false
        beginNew(connection, null)
        val text = mutable.value.entry(target).text
        val command = prefix.trimEnd()
        val existing = text.trimStart()
        val alreadyPrefilled =
            existing.startsWith(command) &&
                (existing.length == command.length || existing[command.length].isWhitespace())
        if (!alreadyPrefilled) edit(connection, target, prefix + text)
        return true
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
                            ))
            )
        )
        serverTarget(key)?.let { synchronize(connection, it) }
    }

    fun restoreDraft(connection: Connection, target: ComposerTarget, key: String) {
        val journal = mutable.value.journal ?: return
        if (!connection.current() || mutable.value.entry(target).text.isNotEmpty()) return
        val text = journal.retainedDrafts[key] ?: return
        val draftKey = mutable.value.draftKey(target)
        val draft = journal.drafts[draftKey] ?: EditableComposerDraft()
        replace(
            journal.copy(
                retainedDrafts = journal.retainedDrafts - key,
                drafts =
                    journal.drafts +
                        (draftKey to
                            draft.copy(
                                text = text,
                                dirty = true,
                                revision = draft.revision + 1,
                                source = target.key,
                            )),
            )
        )
        serverTarget(draftKey)?.let { synchronize(connection, it) }
    }

    fun retrySync(connection: Connection, target: ComposerTarget) {
        serverTarget(mutable.value.draftKey(target))?.let {
            synchronize(connection, it, refresh = true)
        }
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
                        val remote = connection.service.composerDraft(target).plainText()
                        currentCoroutineContext().ensureActive()
                        if (!current()) return@launch
                        if (remote == null) {
                            syncStatus(target.key, ComposerSync.Unsupported)
                            return@launch
                        }
                        readableDrafts += target.key
                        journal = mutable.value.journal ?: return@launch
                        val local = journal.drafts[target.key] ?: EditableComposerDraft()
                        if (
                            !local.dirty &&
                                local.revision == before.revision &&
                                local.text != remote
                        ) {
                            replace(
                                journal.copy(
                                    drafts =
                                        journal.drafts + (target.key to local.copy(text = remote))
                                )
                            )
                        }
                    }
                    while (current()) {
                        val draft = mutable.value.journal?.drafts?.get(target.key) ?: break
                        if (!draft.dirty) break
                        syncStatus(target.key, ComposerSync.Saving)
                        // Web flushes explicit clears immediately; ordinary edits use its 500ms
                        // debounce.
                        if (
                            draft.text.isNotEmpty() &&
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
                        connection.service.saveComposerDraft(target, draft.text)
                        currentCoroutineContext().ensureActive()
                        if (!current()) return@launch
                        journal = mutable.value.journal ?: return@launch
                        if (journal.drafts[target.key] == draft)
                            replace(
                                journal.copy(
                                    drafts =
                                        journal.drafts + (target.key to draft.copy(dirty = false))
                                )
                            )
                    }
                    if (current()) syncStatus(target.key, ComposerSync.Saved)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (current()) {
                        report(connection, error)
                        syncStatus(target.key, ComposerSync.Failed)
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

    fun retryLocal(connection: Connection) {
        if (connection.current()) {
            mutable.value.journal?.let { replace(it) }
            mutable.value.journal
                ?.drafts
                ?.filterValues { it.dirty }
                ?.keys
                ?.forEach { key -> serverTarget(key)?.let { synchronize(connection, it) } }
        }
    }

    fun beginNew(connection: Connection, projectId: String?) {
        if (!connection.current()) return
        val target = ComposerTarget(projectId = projectId)
        val old = mutable.value.entry(target)
        if (old.createdThreadId != null) put(target.key, old.copy(createdThreadId = null))
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

    private fun begin(connection: Connection, key: String, checking: Boolean = false): Operation? {
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
        return Operation(key, connection, checking).also {
            operations[key] = it
            mutable.value =
                mutable.value.copy(
                    busy = operations.keys.toSet(),
                    checking = checkingTargets(),
                    failed = mutable.value.failed - key,
                    unobserved = mutable.value.unobserved - key,
                )
        }
    }

    fun send(connection: Connection, target: ComposerTarget) {
        if (!mutable.value.canSend(target) || !connection.current()) return
        val op = begin(connection, target.key) ?: return
        val entry = mutable.value.entry(target)
        val threadId = target.threadId ?: UUID.randomUUID().toString()
        val eventId = UUID.randomUUID().toString()
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
                else null,
                SendRequestVariant1(
                    prompt = entry.text,
                    threadId = threadId,
                    clientEventId = eventId,
                    chatThreadSortEventId = UUID.randomUUID().toString(),
                    hasTextContent = true,
                    userMessage =
                        SendRequestVariant1UserMessage(
                            CanonicalInteger1,
                            listOf(
                                SendRequestVariant1UserMessagePartsItemVariant1(
                                    SendRequestVariant1UserMessagePartsItemVariant1Type.TEXT,
                                    entry.text,
                                )
                            ),
                        ),
                ),
                TextStage.Prepared,
            )
        val journal = mutable.value.journal ?: return
        val draftKey = mutable.value.draftKey(target)
        val draft = journal.drafts[draftKey] ?: EditableComposerDraft()
        replace(
            journal.copy(
                entries =
                    journal.entries +
                        (op.key to entry.copy(text = "", pending = pending, receipt = null)),
                drafts =
                    journal.drafts +
                        (draftKey to
                            draft.copy(
                                text = "",
                                dirty = true,
                                revision = draft.revision + 1,
                                source = target.key,
                            )),
            )
        )
        serverTarget(draftKey)?.let { synchronize(connection, it) }
        dispatch(op)
    }

    /** Explicit user recovery always reuses the frozen request and all original UUIDs. */
    fun retry(connection: Connection, target: ComposerTarget) {
        if (mutable.value.entry(target).pending == null) return
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

    fun recover(connection: Connection, target: ComposerTarget, failureId: String, reset: Boolean) {
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
        if (previous?.submitted == true && previous.selection == selected) return
        if (previous?.reset != null && previous.outcome == null && previous.selection != selected)
            return
        val op = begin(connection, target.key) ?: return
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

    fun reconcileMessages(connection: Connection, threadId: String, persistedIds: Set<String>) {
        if (!connection.current()) return
        val state = mutable.value
        val matched =
            state.receiptMessages.values
                .filter { it.threadId == threadId && it.eventId in persistedIds }
                .map { it.eventId }
        if (matched.isNotEmpty())
            mutable.value = state.copy(receiptMessages = state.receiptMessages - matched)
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

    private fun stage(op: Operation, pending: PendingText, stage: TextStage): PendingText {
        val value = pending.copy(stage = stage)
        val entry = checkNotNull(mutable.value.journal?.entries?.get(op.key))
        check(entry.pending?.eventId == pending.eventId)
        put(op.key, entry.copy(pending = value))
        return value
    }

    private fun dispatch(op: Operation) {
        op.job =
            op.connection.scope.launch {
                try {
                    deliver(op)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    fail(op, error)
                } finally {
                    finish(op)
                }
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
                    settle(op, pending, observed.disposition)
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

    fun observe(connection: Connection, target: ComposerTarget) {
        val entry = mutable.value.entry(target)
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
                            settle(op, checkNotNull(latest.pending), observed.disposition)
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
                                    (event to preview.copy(disposition = observed.disposition)),
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

    private fun settle(op: Operation, pending: PendingText, disposition: TextDisposition) {
        if (!current(op)) return
        val journal = mutable.value.journal ?: return
        val entry = journal.entries[op.key] ?: return
        if (entry.pending?.eventId != pending.eventId) return
        val destination = "thread:${pending.threadId}"
        if (
            destination != op.key &&
                (journal.drafts[destination]?.text?.isNotEmpty() == true ||
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
            if (draft != null && draft.source == op.key && draft.text.isNotEmpty()) {
                drafts =
                    drafts +
                        (destination to draft.copy(dirty = true)) +
                        (source to
                            draft.copy(text = "", dirty = true, revision = draft.revision + 1))
            }
        }
        val history = op.connection.history?.uiState?.value
        val hasMessage =
            history?.thread?.id == pending.threadId &&
                pending.eventId in history.transcript?.persistedIds.orEmpty()
        val receiptMessages = mutable.value.receiptMessages
        replace(
            journal.copy(entries = entries, drafts = drafts),
            receiptMessages =
                if (hasMessage) receiptMessages
                else receiptMessages + (pending.eventId to pending.preview(disposition)),
        )
        if (pending.create != null) {
            synchronize(op.connection, ServerDraftTarget())
            synchronize(op.connection, ServerDraftTarget(pending.threadId))
        }
        val list = op.connection.chatList
        val create = pending.create
        if (create == null) list?.acknowledgeOutgoingActivity(pending)
        else
            list?.retainAcceptedNewChats(
                listOf(ProvisionalChat(pending.threadId, create.projectId))
            )
        op.connection.accepted(pending.threadId)
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
            mutable.value = mutable.value.copy(failed = mutable.value.failed + op.key)
        }
    }

    private fun finish(op: Operation) {
        if (operations[op.key] === op) {
            restoreUnsentReset(op)
            operations.remove(op.key)
            mutable.value =
                mutable.value.copy(busy = operations.keys.toSet(), checking = checkingTargets())
        }
    }
}
