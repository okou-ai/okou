package ai.okou.android.instructions

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.auth.WorkspaceIdentity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** One main-thread transaction owner per attached origin/user/workspace, shared by Activities. */
internal class PersonalInstructionsOwner(
    private val store: PersonalInstructionsDraftStore,
    private val identity: WorkspaceIdentity,
) {
    class Connection(
        val service: PersonalInstructionsService,
        val scope: CoroutineScope,
        val authorized: () -> Boolean,
        val onFailure: (Exception) -> Unit,
    ) {
        var retired = false
            private set

        fun current() = !retired && authorized()

        fun retire() {
            retired = true
        }
    }

    private class Operation(val connection: Connection, val before: PersonalInstructionsState) {
        var job: Job? = null
    }

    private val mutable = MutableStateFlow(PersonalInstructionsState())
    val uiState = mutable.asStateFlow()
    private val localScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val connections = mutableSetOf<Connection>()
    private var operation: Operation? = null
    private var restored = false
    private var journalPresent = false
    private var pendingJournal: Deferred<InstructionsCommit>? = null
    private var started = false

    fun attach(connection: Connection) {
        connections += connection
    }

    fun detach(connection: Connection): Boolean {
        operation
            ?.takeIf { it.connection === connection }
            ?.let {
                finish(it, interrupted = true)
                it.job?.cancel()
            }
        connections -= connection
        if (connections.isNotEmpty()) return false
        localScope.cancel()
        return true
    }

    private fun current(op: Operation) = operation === op && op.connection.current()

    private suspend fun requireCurrent(op: Operation) {
        currentCoroutineContext().ensureActive()
        if (!current(op)) throw CancellationException("Instructions request retired")
    }

    private fun replaceDraft(
        draft: InstructionsDraft?,
        state: PersonalInstructionsState = mutable.value,
    ): Deferred<InstructionsCommit>? {
        val journal = draft?.takeIf { it.attempted }
        val needsWrite = journal != null || journalPresent
        if (!needsWrite) {
            mutable.value = state.copy(draft = draft)
            return null
        }
        journalPresent = true
        return store.persist(identity, journal).also { pending ->
            pendingJournal = pending
            mutable.value = state.copy(draft = draft, persistence = InstructionsPersistence.Pending)
            localScope.launch {
                val result =
                    try {
                        pending.await()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        null
                    }
                if (pendingJournal === pending) {
                    pendingJournal = null
                    if (result == InstructionsCommit.Committed && journal == null)
                        journalPresent = false
                    mutable.value =
                        mutable.value.copy(
                            persistence =
                                if (result == InstructionsCommit.Committed)
                                    InstructionsPersistence.Durable
                                else InstructionsPersistence.Failed,
                        )
                }
            }
        }
    }

    fun edit(connection: Connection, content: String) {
        val state = mutable.value
        if (!connection.current() || !state.canEdit || content == state.content) return
        val base = state.saved ?: return
        val next = state.copy(saveRejected = false)
        if (content == base.content && state.read != InstructionsRead.Failed)
            replaceDraft(null, next)
        else mutable.value = next.copy(draft = InstructionsDraft(content, base))
    }

    fun retryLocalDraft(connection: Connection) {
        if (connection.current() && restored && !mutable.value.busy && mutable.value.localFailure)
            replaceDraft(mutable.value.draft)
    }

    fun discardEdits(connection: Connection, draft: InstructionsDraft): Boolean {
        val state = mutable.value
        if (!connection.current() || state.phase == InstructionsPhase.Saving) return false
        if (state.draft == null) return true
        if (state.draft !== draft || draft.attempted) return false
        replaceDraft(null, state.copy(saveRejected = false))
        return true
    }

    fun refreshFromForeground(connection: Connection) {
        if (started) refresh(connection)
    }

    fun open(connection: Connection) {
        if (!connection.current()) return
        val state = mutable.value
        if (state.draft == null) {
            val cached = if (restored) store.freshConfirmed(identity) else null
            mutable.value =
                state.copy(
                    saved = cached,
                    read = if (cached == null) InstructionsRead.Idle else InstructionsRead.Ready,
                )
        }
        refresh(connection)
    }

    fun refresh(connection: Connection) {
        val before = mutable.value
        if (!connection.current() || before.busy) return
        started = true
        val op = Operation(connection, before)
        operation = op
        val background =
            before.saved != null &&
                before.draft?.attempted != true &&
                (before.read == InstructionsRead.Ready ||
                    before.read == InstructionsRead.RefreshFailed)
        mutable.value =
            before.copy(
                request =
                    if (background) InstructionsRequest.Refreshing else InstructionsRequest.Reading,
                read = if (background) InstructionsRead.Ready else before.read,
                recoveryVersion = null,
            )
        op.job =
            connection.scope.launch {
                try {
                    if (!restored) {
                        val local = store.load(identity)
                        requireCurrent(op)
                        restored = true
                        journalPresent = local.draft != null || !local.durable
                        val cached = store.freshConfirmed(identity)
                        mutable.value =
                            mutable.value.copy(
                                saved = cached ?: local.draft?.base,
                                draft = local.draft,
                                request =
                                    if (cached != null && local.draft?.attempted != true)
                                        InstructionsRequest.Refreshing
                                    else InstructionsRequest.Reading,
                                read =
                                    if (cached != null || local.draft != null)
                                        InstructionsRead.Ready
                                    else InstructionsRead.Idle,
                                persistence =
                                    if (local.durable) InstructionsPersistence.Durable
                                    else InstructionsPersistence.Failed,
                            )
                    }
                    requireCurrent(op)
                    val saved = connection.service.personalInstructions()
                    requireCurrent(op)
                    acceptRead(saved)
                } catch (cancelled: CancellationException) {
                    finish(op, interrupted = true)
                    throw cancelled
                } catch (error: Exception) {
                    failRead(op, error)
                } finally {
                    if (operation === op) finish(op)
                }
            }
    }

    private fun acceptRead(saved: PersonalInstructions) {
        store.rememberConfirmed(identity, saved)
        val state = mutable.value
        val draft = state.draft
        val next = state.copy(saved = saved, read = InstructionsRead.Ready, recoveryVersion = null)
        when {
            draft == null -> mutable.value = next
            draft.attempted && saved.version == draft.base.version ->
                mutable.value = next.copy(recoveryVersion = saved.version)
            draft.content == saved.content -> replaceDraft(null, next.copy(saveRejected = false))
            draft.attempted -> replaceDraft(draft.copy(attempted = false), next)
            else -> mutable.value = next
        }
    }

    fun save(connection: Connection) {
        val before = mutable.value
        if (!connection.current() || (!before.canSave && !before.canRetrySave)) return
        val draft = checkNotNull(before.draft)
        val attempt =
            if (draft.attempted) draft
            else draft.copy(base = checkNotNull(before.saved), attempted = true)
        val op = Operation(connection, before)
        val refresh = operation
        operation = op
        refresh?.job?.cancel()
        // Accept the frozen intent synchronously, before a presentation can retire.
        val durable = prepare(attempt)
        op.job =
            connection.scope.launch {
                try {
                    submit(op, attempt, durable)
                } finally {
                    finish(op)
                }
            }
    }

    private fun prepare(attempt: InstructionsDraft): Deferred<InstructionsCommit> =
        checkNotNull(
            replaceDraft(
                attempt,
                mutable.value.copy(
                    request = InstructionsRequest.Preparing,
                    saveRejected = false,
                    recoveryVersion = null,
                ),
            ),
        )

    private suspend fun submit(
        op: Operation,
        initialAttempt: InstructionsDraft,
        initialReceipt: Deferred<InstructionsCommit>,
    ) {
        var attempt = initialAttempt
        var receipt = initialReceipt
        val resolvingEarlierWrite = checkNotNull(op.before.draft).attempted
        repeat(2) { index ->
            try {
                send(op, attempt, receipt)
                return
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (!current(op)) return
                val status = (error as? ApiFailure.Http)?.status
                if (!resolvingEarlierWrite && status == 409 && index == 0) {
                    // This request was definitively rejected. Freeze the same text on the new base.
                    replaceDraft(attempt.copy(attempted = false))
                    val latest = readAfterSave(op)
                    if (latest == null) {
                        if (current(op)) mutable.value = mutable.value.copy(saveRejected = true)
                        return
                    }
                    if (latest.content == attempt.content) return
                    attempt = attempt.copy(base = latest)
                    receipt = prepare(attempt)
                } else if (!resolvingEarlierWrite && (status == 400 || status == 409)) {
                    replaceDraft(
                        attempt.copy(attempted = false),
                        mutable.value.copy(saveRejected = true),
                    )
                    return
                } else {
                    report(op.connection, error)
                    requireCurrent(op)
                    readAfterSave(op)
                    return
                }
            }
        }
    }

    private suspend fun send(
        op: Operation,
        attempt: InstructionsDraft,
        receipt: Deferred<InstructionsCommit>,
    ) {
        val result =
            try {
                receipt.await()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                return
            }
        requireCurrent(op)
        if (result != InstructionsCommit.Committed) return
        mutable.value = mutable.value.copy(request = InstructionsRequest.Sending)
        val saved =
            op.connection.service.updatePersonalInstructions(attempt.content, attempt.base.version)
        requireCurrent(op)
        if (saved.content != attempt.content || saved.version == attempt.base.version)
            throw ApiFailure.IncompatibleResponse()
        acceptRead(saved)
    }

    private suspend fun readAfterSave(op: Operation): PersonalInstructions? =
        try {
            val saved = op.connection.service.personalInstructions()
            requireCurrent(op)
            acceptRead(saved)
            saved
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            failRead(op, error)
            null
        }

    private fun failRead(op: Operation, error: Exception) {
        if (!current(op)) return
        report(op.connection, error)
        if (!current(op)) return
        val denied = error is ApiFailure.Http && (error.status == 403 || error.status == 404)
        if (denied) store.forgetConfirmed(identity)
        val state = mutable.value
        val read =
            when {
                denied || state.read == InstructionsRead.Unavailable -> InstructionsRead.Unavailable
                state.saved != null && store.freshConfirmed(identity) != null ->
                    InstructionsRead.RefreshFailed
                else -> InstructionsRead.Failed
            }
        mutable.value = state.copy(read = read, recoveryVersion = null)
    }

    private fun report(connection: Connection, error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            connection.onFailure(error)
    }

    private fun finish(op: Operation, interrupted: Boolean = false) {
        if (operation !== op) return
        // A preflight failure/cancellation cannot create an unknown remote outcome. A retry of an
        // older unknown operation, however, must keep that older attempt frozen.
        val preparing = mutable.value.request == InstructionsRequest.Preparing
        val reading =
            mutable.value.request == InstructionsRequest.Reading ||
                mutable.value.request == InstructionsRequest.Refreshing
        operation = null
        val state = mutable.value
        val next =
            state.copy(
                request = InstructionsRequest.None,
                read =
                    if (interrupted && reading && state.read != InstructionsRead.Unavailable)
                        InstructionsRead.Failed
                    else state.read,
            )
        if (preparing) {
            replaceDraft(
                op.before.draft,
                next.copy(recoveryVersion = op.before.recoveryVersion),
            )
        } else mutable.value = next
    }
}
