package ai.okou.android.instructions

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.api.retryBoundedRead
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
    private val openPanels = mutableSetOf<Connection>()
    private var operation: Operation? = null
    private var restored = false
    private var journalPresent = false
    private var pendingJournal: Deferred<InstructionsCommit>? = null
    private var started = false
    private var refreshBeforeSave = false

    fun attach(connection: Connection) {
        connections += connection
    }

    fun detach(connection: Connection): Boolean {
        closePanel(connection)
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
        val next =
            state.copy(
                draftRevision = state.draftRevision + 1,
                saveRejected = false,
                saveConfirmed = false,
            )
        if (content == base.content && state.read != InstructionsRead.Failed)
            replaceDraft(null, next)
        else if (state.draft?.attempted == true)
            replaceDraft(InstructionsDraft(content, base), next)
        else mutable.value = next.copy(draft = InstructionsDraft(content, base))
    }

    fun retryLocalDraft(connection: Connection) {
        if (connection.current() && restored && !mutable.value.busy && mutable.value.localFailure)
            replaceDraft(mutable.value.draft)
    }

    fun discardEdits(connection: Connection, draftRevision: Long): Boolean {
        val state = mutable.value
        if (!connection.current() || state.saveInProgress) return false
        if (state.draft == null) return true
        // The read may settle a journal entry without replacing the user's edit.
        if (state.draftRevision != draftRevision) return false
        replaceDraft(null, state.copy(saveRejected = false))
        return true
    }

    fun refreshFromForeground(connection: Connection) {
        if (started) refresh(connection)
    }

    fun open(connection: Connection, restoring: Boolean) {
        if (!connection.current()) return
        val joining = openPanels.any { it !== connection && it.current() }
        openPanels += connection
        val state = mutable.value
        if (restoring || state.busy) return
        if (!joining && state.draft == null) {
            val cached = if (restored) store.freshConfirmed(identity) else null
            mutable.value =
                state.copy(
                    saved = cached,
                    read = if (cached == null) InstructionsRead.Idle else InstructionsRead.Ready,
                )
        }
        refresh(connection)
    }

    fun closePanel(connection: Connection) {
        openPanels -= connection
    }

    fun refresh(connection: Connection) {
        val before = mutable.value
        if (!connection.current() || before.busy) return
        started = true
        val op = Operation(connection, before)
        operation = op
        val background =
            before.saved != null &&
                (before.read == InstructionsRead.Ready ||
                    before.read == InstructionsRead.RefreshFailed)
        mutable.value =
            before.copy(
                request =
                    if (background) InstructionsRequest.Refreshing else InstructionsRequest.Reading,
                read = if (background) InstructionsRead.Ready else before.read,
            )
        op.job =
            connection.scope.launch {
                try {
                    if (!restored) {
                        val local = store.load(identity)
                        requireCurrent(op)
                        restored = true
                        journalPresent = local.draft != null || !local.durable
                        refreshBeforeSave = local.draft?.attempted == true
                        val cached = store.freshConfirmed(identity)
                        mutable.value =
                            mutable.value.copy(
                                saved = cached ?: local.draft?.base,
                                draft = local.draft,
                                request =
                                    if (cached != null) InstructionsRequest.Refreshing
                                    else InstructionsRequest.Reading,
                                read =
                                    if (cached != null || local.draft != null)
                                        InstructionsRead.Ready
                                    else InstructionsRead.Idle,
                                persistence =
                                    if (local.durable) InstructionsPersistence.Durable
                                    else InstructionsPersistence.Failed,
                                saveRejected = refreshBeforeSave,
                            )
                    }
                    read(op)
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

    private fun rememberConfirmed(saved: PersonalInstructions): PersonalInstructionsState {
        store.rememberConfirmed(identity, saved)
        refreshBeforeSave = false
        return mutable.value.copy(saved = saved, read = InstructionsRead.Ready)
    }

    private fun acceptRead(saved: PersonalInstructions) {
        val next = rememberConfirmed(saved)
        val draft = next.draft
        when {
            draft == null -> mutable.value = next
            draft.content == saved.content ->
                replaceDraft(null, next.copy(saveRejected = false, saveConfirmed = false))
            draft.attempted ->
                replaceDraft(draft.copy(attempted = false), next.copy(saveRejected = true))
            else -> mutable.value = next
        }
    }

    fun save(connection: Connection) {
        val before = mutable.value
        if (!connection.current() || !before.canSave) return
        val attempt =
            checkNotNull(before.draft).copy(base = checkNotNull(before.saved), attempted = true)
        val op = Operation(connection, before)
        val refresh = operation
        operation = op
        refresh?.job?.cancel()
        mutable.value =
            before.copy(
                request = InstructionsRequest.Preparing,
                saveRejected = false,
                saveConfirmed = false,
            )
        // Accept a known-base intent synchronously, before a presentation can retire.
        val durable = if (refreshBeforeSave) null else checkNotNull(replaceDraft(attempt))
        op.job =
            connection.scope.launch {
                try {
                    submit(op, attempt, durable)
                } catch (cancelled: CancellationException) {
                    finish(op, interrupted = true)
                    throw cancelled
                } catch (error: Exception) {
                    rejectSave(op, error)
                } finally {
                    finish(op)
                }
            }
    }

    private suspend fun submit(
        op: Operation,
        initialAttempt: InstructionsDraft,
        initialReceipt: Deferred<InstructionsCommit>?,
    ) {
        var attempt = initialAttempt
        val receipt =
            initialReceipt
                ?: run {
                    // A new Save can refresh a stale base before sending its one conditional write.
                    val latest = op.connection.service.personalInstructions()
                    requireCurrent(op)
                    val confirmed = rememberConfirmed(latest)
                    if (latest.content == attempt.content) {
                        replaceDraft(null, confirmed.copy(saveConfirmed = true))
                        return
                    }
                    attempt = attempt.copy(base = latest)
                    checkNotNull(replaceDraft(attempt, confirmed))
                }
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
        replaceDraft(null, rememberConfirmed(saved).copy(saveConfirmed = true))
    }

    private fun rejectSave(op: Operation, error: Exception) {
        if (!current(op)) return
        report(op.connection, error)
        if (!current(op)) return
        val status = (error as? ApiFailure.Http)?.status
        val denied = status == 403 || status == 404
        if (denied) store.forgetConfirmed(identity)
        val state = mutable.value
        val next =
            state.copy(
                read = if (denied) InstructionsRead.Unavailable else state.read,
                saveRejected = true,
            )
        if (state.request == InstructionsRequest.Sending) {
            refreshBeforeSave = status == null || status == 408 || status == 409 || status >= 500
            replaceDraft(state.draft?.copy(attempted = false), next)
        } else mutable.value = next
    }

    private suspend fun read(op: Operation) {
        requireCurrent(op)
        suspend fun attempt(): Exception? =
            try {
                val saved = op.connection.service.personalInstructions()
                requireCurrent(op)
                acceptRead(saved)
                null
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                error
            }
        val error = retryBoundedRead({ current(op) }, ::attempt)
        if (error != null) failRead(op, error)
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
                state.saved != null &&
                    (state.request == InstructionsRequest.Refreshing ||
                        state.draft?.attempted == true ||
                        store.freshConfirmed(identity) != null) -> InstructionsRead.RefreshFailed
                else -> InstructionsRead.Failed
            }
        mutable.value = state.copy(read = read)
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
        val state = mutable.value
        val reading =
            state.request == InstructionsRequest.Reading ||
                state.request == InstructionsRequest.Refreshing
        operation = null
        val next =
            state.copy(
                request = InstructionsRequest.None,
                read =
                    if (interrupted && reading && state.read != InstructionsRead.Unavailable)
                        InstructionsRead.Failed
                    else state.read,
            )
        when {
            state.request == InstructionsRequest.Preparing && !state.saveConfirmed ->
                replaceDraft(op.before.draft, next)
            interrupted && state.request == InstructionsRequest.Sending -> {
                refreshBeforeSave = true
                mutable.value = next.copy(saveRejected = true)
            }
            else -> mutable.value = next
        }
    }
}
