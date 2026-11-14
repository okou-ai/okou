package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.CanonicalInteger1
import ai.okou.android.api.generated.CreateThreadRequest
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
import kotlinx.coroutines.launch

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
    ) {
        var retired = false

        fun current() = !retired && authorized()
    }

    private class Operation(
        val key: String,
        val connection: Connection,
        val checking: Boolean = false,
    ) {
        var job: Job? = null
    }

    private val mutable = MutableStateFlow(ComposerState())
    val uiState = mutable.asStateFlow()
    private val localScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val connections = mutableSetOf<Connection>()
    private val operations = mutableMapOf<String, Operation>()
    private var restoring: Job? = null
    private var contextJob: Job? = null
    private var contextConnection: Connection? = null
    private var revision = 0L

    fun attach(connection: Connection) {
        connections += connection
    }

    fun detach(connection: Connection): Boolean {
        if (contextConnection === connection) {
            contextJob?.cancel()
            contextJob = null
            contextConnection = null
            mutable.value =
                mutable.value.copy(context = ComposerContext.Idle, defaultAgentId = null)
        }
        operations.values
            .filter { it.connection === connection }
            .toList()
            .forEach { op ->
                operations.remove(op.key)
                mutable.value =
                    mutable.value.copy(busy = operations.keys.toSet(), checking = checkingTargets())
                op.job?.cancel()
            }
        connections -= connection
        if (connections.isNotEmpty()) return false
        localScope.cancel()
        return true
    }

    private fun current(op: Operation) = operations[op.key] === op && op.connection.current()

    private suspend fun requireCurrent(op: Operation) {
        currentCoroutineContext().ensureActive()
        if (!current(op)) throw CancellationException("Composer connection retired")
    }

    private fun replace(journal: ComposerJournal) {
        val ticket = ++revision
        val pending = store.persist(identity, journal)
        mutable.value =
            mutable.value.copy(journal = journal, persistence = ComposerPersistence.Pending)
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

    private fun put(key: String, value: ComposerEntry) {
        val journal = mutable.value.journal ?: return
        val entries =
            if (value.text.isEmpty() && value.pending == null && value.receipt == null)
                journal.entries - key
            else journal.entries + (key to value)
        replace(journal.copy(entries = entries))
    }

    fun open(connection: Connection, target: ComposerTarget) {
        if (!connection.current()) return
        if (mutable.value.journal == null && restoring?.isActive != true) {
            mutable.value = mutable.value.copy(persistence = ComposerPersistence.Loading)
            restoring =
                localScope.launch {
                    try {
                        val saved = store.load(identity)
                        mutable.value =
                            mutable.value.copy(
                                journal = saved.journal,
                                persistence =
                                    if (saved.durable) ComposerPersistence.Durable
                                    else ComposerPersistence.Failed,
                            )
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        mutable.value = mutable.value.copy(persistence = ComposerPersistence.Failed)
                    }
                }
        }
        if (target.threadId == null && contextJob?.isActive != true) {
            contextConnection = connection
            mutable.value = mutable.value.copy(context = ComposerContext.Loading)
            contextJob =
                connection.scope.launch {
                    try {
                        val agent = connection.service.newChatAgent()
                        currentCoroutineContext().ensureActive()
                        if (connection.current())
                            mutable.value =
                                mutable.value.copy(
                                    defaultAgentId = agent,
                                    context =
                                        if (agent == null) ComposerContext.Unavailable
                                        else ComposerContext.Ready,
                                )
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
    }

    fun edit(connection: Connection, target: ComposerTarget, text: String) {
        if (!connection.current() || mutable.value.journal == null) return
        val old = mutable.value.entry(target)
        if (old.text != text) put(target.key, old.copy(text = text))
    }

    fun retryLocal(connection: Connection) {
        if (connection.current()) mutable.value.journal?.let(::replace)
    }

    fun beginNew(connection: Connection) {
        if (connection.current())
            mutable.value = mutable.value.copy(openedThread = null, openedFrom = null)
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
        val agent =
            (if (target.threadId == null) mutable.value.defaultAgentId else target.agentId)
                ?: return
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
                        agentId = agent,
                        projectId = target.projectId,
                        clientThreadId = threadId,
                        eventId = UUID.randomUUID().toString(),
                    )
                else null,
                SendRequestVariant1(
                    agentId = agent,
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
        put(op.key, entry.copy(text = "", pending = pending, receipt = null))
        dispatch(op)
    }

    /** Explicit user recovery always reuses the frozen request and all original UUIDs. */
    fun retry(connection: Connection, target: ComposerTarget) {
        if (mutable.value.entry(target).pending == null) return
        begin(connection, target.key)?.let(::dispatch)
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
                    var pending = checkNotNull(mutable.value.journal?.entries?.get(op.key)?.pending)
                    if (
                        pending.create != null &&
                            pending.stage in setOf(TextStage.Prepared, TextStage.Creating)
                    ) {
                        pending = stage(op, pending, TextStage.Creating)
                        durable(op, pending)
                        val result =
                            op.connection.service.createThread(checkNotNull(pending.create))
                        requireCurrent(op)
                        if (
                            result.id != pending.threadId ||
                                result.projectId != pending.create.projectId
                        )
                            throw ApiFailure.IncompatibleResponse()
                        pending = stage(op, pending, TextStage.Created)
                    }
                    pending = stage(op, pending, TextStage.Sending)
                    durable(op, pending)
                    val result = op.connection.service.sendInput(pending.send)
                    requireCurrent(op)
                    if (result.threadId != pending.threadId) throw ApiFailure.IncompatibleResponse()
                    settle(op, pending, TextDisposition.Accepted)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    fail(op, error)
                } finally {
                    finish(op)
                }
            }
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
                        put(
                            op.key,
                            latest.copy(receipt = TextReceipt(thread, event, observed.disposition)),
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
                journal.entries[destination]?.let { it.text.isNotEmpty() || it.pending != null } ==
                    true
        )
            throw ApiFailure.IncompatibleResponse()
        val value =
            entry.copy(
                pending = null,
                receipt = TextReceipt(pending.threadId, pending.eventId, disposition),
            )
        // Retain meaningful input, plus this one delivery receipt; do not accumulate read history.
        val meaningful = journal.entries.filterValues { it.text.isNotEmpty() || it.pending != null }
        replace(journal.copy(entries = (meaningful - op.key) + (destination to value)))
        mutable.value = mutable.value.copy(openedThread = pending.threadId, openedFrom = op.key)
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
            report(op.connection, error)
            mutable.value = mutable.value.copy(failed = mutable.value.failed + op.key)
        }
    }

    private fun finish(op: Operation) {
        if (operations[op.key] === op) {
            operations.remove(op.key)
            mutable.value =
                mutable.value.copy(busy = operations.keys.toSet(), checking = checkingTargets())
        }
    }
}
