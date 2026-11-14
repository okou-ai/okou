package ai.okou.android.instructions

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.auth.WorkspaceIdentity
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
        var revision: Long = 0
    }

    private val mutable = MutableStateFlow(PersonalInstructionsState())
    val uiState = mutable.asStateFlow()
    private val localScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val connections = mutableSetOf<Connection>()
    private var operation: Operation? = null
    private var restored = false
    private var started = false
    private var revision = 0L

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

    /** Compare-and-replace prevents settlement of an older intent from removing new input. */
    private fun replaceDraft(
        expected: Long,
        draft: InstructionsDraft?,
        state: PersonalInstructionsState = mutable.value,
    ) =
        if (expected != revision) null
        else {
            val accepted = ++revision
            store.persist(identity, draft).also { pending ->
                mutable.value =
                    state.copy(draft = draft, persistence = InstructionsPersistence.Pending)
                localScope.launch {
                    val result =
                        try {
                            pending.await()
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            null
                        }
                    if (revision == accepted)
                        mutable.value =
                            mutable.value.copy(
                                persistence =
                                    if (result == InstructionsCommit.Committed)
                                        InstructionsPersistence.Durable
                                    else InstructionsPersistence.Failed
                            )
                }
            }
        }

    fun edit(connection: Connection, content: String) {
        val state = mutable.value
        if (!connection.current() || !state.canEdit || content == state.content) return
        val base = state.draft?.base ?: state.saved ?: return
        val draft =
            if (
                content == base.content &&
                    state.read == InstructionsRead.Ready &&
                    !state.conflicting
            )
                null
            else InstructionsDraft(content, base)
        val next =
            state.copy(
                rejection =
                    if (state.rejection == InstructionsRejection.Invalid) InstructionsRejection.None
                    else state.rejection
            )
        replaceDraft(revision, draft, next)
    }

    fun retryLocalDraft(connection: Connection) {
        if (connection.current() && restored && !mutable.value.busy && mutable.value.localFailure)
            replaceDraft(revision, mutable.value.draft)
    }

    fun discard(connection: Connection) {
        val state = mutable.value
        if (!connection.current() || !state.canEdit || state.draft == null) return
        if (state.conflicting) refresh(connection, discard = true)
        else {
            replaceDraft(revision, null, state.copy(rejection = InstructionsRejection.None))
        }
    }

    fun refreshFromForeground(connection: Connection) {
        if (started) refresh(connection)
    }

    fun refresh(connection: Connection, discard: Boolean = false) {
        if (!connection.current() || mutable.value.busy) return
        started = true
        val op = Operation(connection, mutable.value)
        operation = op
        mutable.value =
            mutable.value.copy(request = InstructionsRequest.Reading, recoveryVersion = null)
        op.job =
            connection.scope.launch {
                try {
                    if (!restored) {
                        val local = store.load(identity)
                        requireCurrent(op)
                        restored = true
                        mutable.value =
                            mutable.value.copy(
                                saved = local.draft?.base,
                                draft = local.draft,
                                persistence =
                                    if (local.durable) InstructionsPersistence.Durable
                                    else InstructionsPersistence.Failed,
                            )
                    }
                    op.revision = revision
                    requireCurrent(op)
                    if (!connection.service.personalInstructionsEnabled()) {
                        requireCurrent(op)
                        mutable.value = mutable.value.copy(read = InstructionsRead.Unavailable)
                    } else {
                        requireCurrent(op)
                        val saved = connection.service.personalInstructions()
                        requireCurrent(op)
                        acceptRead(op, saved, discard)
                    }
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

    private fun acceptRead(op: Operation, saved: PersonalInstructions, discard: Boolean = false) {
        if (!current(op) || op.revision != revision) return
        val draft = mutable.value.draft
        val fulfilled =
            draft?.attempted == true &&
                saved.version != draft.base.version &&
                saved.content == draft.content
        // An offline undo remains provisional until its original version is confirmed.
        val unchanged =
            draft != null &&
                !draft.attempted &&
                saved.version == draft.base.version &&
                saved.content == draft.content
        val next =
            mutable.value.copy(
                saved = saved,
                read = InstructionsRead.Ready,
                rejection = InstructionsRejection.None,
                recoveryVersion =
                    if (draft?.attempted == true && saved.version == draft.base.version)
                        saved.version
                    else null,
            )
        if (discard || fulfilled || unchanged) replaceDraft(op.revision, null, next)
        else if (draft?.attempted == true && saved.version != draft.base.version)
            replaceDraft(op.revision, draft.copy(attempted = false), next)
        else mutable.value = next
    }

    fun save(connection: Connection) {
        val before = mutable.value
        if (!connection.current() || (!before.canSave && !before.canRetrySave)) return
        val attempt = checkNotNull(before.draft).copy(attempted = true)
        val op = Operation(connection, before)
        operation = op
        val preparing =
            before.copy(
                request = InstructionsRequest.Preparing,
                rejection = InstructionsRejection.None,
                recoveryVersion = null,
            )
        // Accept the frozen intent synchronously, before a presentation can retire.
        val durable = checkNotNull(replaceDraft(revision, attempt, preparing))
        op.revision = revision
        op.job =
            connection.scope.launch {
                try {
                    try {
                        val receipt = durable.await()
                        requireCurrent(op)
                        if (receipt != InstructionsCommit.Committed || op.revision != revision)
                            return@launch
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        return@launch
                    }
                    mutable.value = mutable.value.copy(request = InstructionsRequest.Sending)
                    try {
                        val saved =
                            connection.service.updatePersonalInstructions(
                                attempt.content,
                                attempt.base.version,
                            )
                        requireCurrent(op)
                        if (
                            saved.content != attempt.content ||
                                saved.version == attempt.base.version
                        )
                            throw ApiFailure.IncompatibleResponse()
                        replaceDraft(
                            op.revision,
                            null,
                            mutable.value.copy(saved = saved, read = InstructionsRead.Ready),
                        )
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        if (!current(op)) return@launch
                        if (
                            error is ApiFailure.Http &&
                                (error.status == 409 ||
                                    error.status == 400 && !before.draft.attempted)
                        ) {
                            val rejected =
                                mutable.value.copy(
                                    rejection =
                                        if (error.status == 409) InstructionsRejection.Conflict
                                        else InstructionsRejection.Invalid
                                )
                            replaceDraft(op.revision, attempt.copy(attempted = false), rejected)
                        } else {
                            report(connection, error)
                            requireCurrent(op)
                            try {
                                val saved = connection.service.personalInstructions()
                                requireCurrent(op)
                                acceptRead(op, saved)
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (read: Exception) {
                                failRead(op, read)
                            }
                        }
                    }
                } finally {
                    finish(op)
                }
            }
    }

    private fun failRead(op: Operation, error: Exception) {
        if (!current(op)) return
        report(op.connection, error)
        if (!current(op)) return
        mutable.value =
            mutable.value.copy(
                read =
                    if (error is ApiFailure.Http && error.status in setOf(403, 404))
                        InstructionsRead.Unavailable
                    else InstructionsRead.Failed,
                recoveryVersion = null,
            )
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
        val reading = mutable.value.request == InstructionsRequest.Reading
        operation = null
        val next =
            mutable.value.copy(
                request = InstructionsRequest.None,
                read = if (interrupted && reading) InstructionsRead.Failed else mutable.value.read,
            )
        if (preparing) {
            replaceDraft(
                op.revision,
                op.before.draft,
                next.copy(recoveryVersion = op.before.recoveryVersion),
            )
        } else mutable.value = next
    }
}
