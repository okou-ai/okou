package ai.okou.android.instructions

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class InstructionsPhase {
    Idle,
    Loading,
    Ready,
    Saving,
    Conflict,
    Uncertain,
    Failed,
    Unavailable,
}

data class PersonalInstructionsState(
    val phase: InstructionsPhase = InstructionsPhase.Idle,
    val saved: PersonalInstructions? = null,
    val draft: InstructionsDraft? = null,
    val persisting: Boolean = false,
    val localFailure: Boolean = false,
    val saveRejected: Boolean = false,
    val recoveryVersion: String? = null,
) {
    val content: String
        get() = draft?.content ?: saved?.content.orEmpty()

    val busy: Boolean
        get() = phase == InstructionsPhase.Loading || phase == InstructionsPhase.Saving

    val canEdit: Boolean
        get() =
            !busy &&
                phase !in setOf(InstructionsPhase.Idle, InstructionsPhase.Unavailable) &&
                (saved != null || draft != null) &&
                draft?.attempted != true

    val canSave: Boolean
        get() =
            phase == InstructionsPhase.Ready &&
                draft != null &&
                !draft.attempted &&
                !content.contains('\u0000')

    val canRetrySave: Boolean
        get() =
            phase == InstructionsPhase.Uncertain &&
                draft?.attempted == true &&
                recoveryVersion == draft.base.version
}

/** Workspace-owned editing/network state; the application store owns accepted local intent. */
class PersonalInstructionsModel(
    private val service: PersonalInstructionsService,
    private val store: PersonalInstructionsDraftStore,
    private val identity: WorkspaceIdentity,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
) : ViewModel() {
    private val mutable = MutableStateFlow(PersonalInstructionsState())
    val uiState = mutable.asStateFlow()
    private var retired = false
    private var started = false
    private var restored = false
    private var localRevision = 0L

    private fun current() = !retired && authorized()

    private suspend fun requireCurrent() {
        currentCoroutineContext().ensureActive()
        if (!current()) throw CancellationException("Instructions editor retired")
    }

    fun open() {
        refresh()
    }

    fun refreshFromForeground() {
        if (started) refresh()
    }

    fun edit(content: String) {
        val state = mutable.value
        if (!current() || !state.canEdit || content == state.content) return
        val base = state.draft?.base ?: state.saved ?: return
        val draft =
            if (content == base.content && state.phase != InstructionsPhase.Conflict) null
            else InstructionsDraft(content, base)
        mutable.value = state.copy(draft = draft, saveRejected = false)
        persistEdit(draft)
    }

    private fun persistEdit(draft: InstructionsDraft?) {
        val revision = ++localRevision
        mutable.value = mutable.value.copy(persisting = true, localFailure = false)
        val pending = store.persist(identity, draft)
        viewModelScope.launch {
            try {
                pending.await()
                requireCurrent()
                if (revision == localRevision)
                    mutable.value = mutable.value.copy(persisting = false)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (current() && revision == localRevision)
                    mutable.value = mutable.value.copy(persisting = false, localFailure = true)
            }
        }
    }

    fun retryLocalDraft() {
        if (current() && !mutable.value.busy) persistEdit(mutable.value.draft)
    }

    fun discard() {
        val state = mutable.value
        if (
            !current() ||
                state.busy ||
                state.phase == InstructionsPhase.Unavailable ||
                state.draft == null ||
                state.draft.attempted
        )
            return
        if (state.phase == InstructionsPhase.Conflict) refresh(discard = true)
        else {
            mutable.value = state.copy(draft = null, saveRejected = false)
            persistEdit(null)
        }
    }

    fun refresh() = refresh(discard = false)

    private fun refresh(discard: Boolean) {
        if (!current() || mutable.value.busy) return
        started = true
        mutable.value =
            mutable.value.copy(phase = InstructionsPhase.Loading, recoveryVersion = null)
        viewModelScope.launch {
            try {
                if (!service.personalInstructionsEnabled()) {
                    requireCurrent()
                    mutable.value = mutable.value.copy(phase = InstructionsPhase.Unavailable)
                    return@launch
                }
                requireCurrent()
                if (!restored) {
                    val local = store.load(identity)
                    requireCurrent()
                    restored = true
                    mutable.value =
                        mutable.value.copy(draft = local.draft, localFailure = !local.durable)
                }
                val saved = service.personalInstructions()
                requireCurrent()
                acceptRead(saved, discard)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                failRead(error)
            }
        }
    }

    private suspend fun replaceDraft(draft: InstructionsDraft?): Boolean {
        ++localRevision
        mutable.value = mutable.value.copy(persisting = true)
        val pending = store.persist(identity, draft)
        return try {
            pending.await()
            requireCurrent()
            mutable.value = mutable.value.copy(persisting = false, localFailure = false)
            true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            requireCurrent()
            mutable.value = mutable.value.copy(persisting = false, localFailure = true)
            false
        }
    }

    private suspend fun acceptRead(saved: PersonalInstructions, discard: Boolean = false) {
        val draft = mutable.value.draft
        val fulfilled =
            draft?.attempted == true &&
                saved.version != draft.base.version &&
                saved.content == draft.content
        if (discard || fulfilled) {
            replaceDraft(null)
            requireCurrent()
            mutable.value =
                mutable.value.copy(
                    saved = saved,
                    draft = null,
                    phase = InstructionsPhase.Ready,
                    recoveryVersion = null,
                )
        } else if (draft?.attempted == true) {
            if (saved.version != draft.base.version) {
                val conflict = draft.copy(attempted = false)
                replaceDraft(conflict)
                requireCurrent()
                mutable.value =
                    mutable.value.copy(
                        saved = saved,
                        draft = conflict,
                        phase = InstructionsPhase.Conflict,
                    )
            } else
                mutable.value =
                    mutable.value.copy(
                        saved = saved,
                        phase = InstructionsPhase.Uncertain,
                        recoveryVersion = saved.version,
                    )
        } else {
            mutable.value =
                mutable.value.copy(
                    saved = saved,
                    phase =
                        if (draft != null && draft.base.version != saved.version)
                            InstructionsPhase.Conflict
                        else InstructionsPhase.Ready,
                    recoveryVersion = null,
                )
        }
    }

    fun save() {
        val state = mutable.value
        if (!current() || (!state.canSave && !state.canRetrySave)) return
        val attempt = checkNotNull(state.draft).copy(attempted = true)
        ++localRevision
        mutable.value =
            state.copy(
                draft = attempt,
                phase = InstructionsPhase.Saving,
                persisting = true,
                saveRejected = false,
                recoveryVersion = null,
            )
        // Accept persistence before a presentation owner can retire; no HTTP write precedes it.
        val durable = store.persist(identity, attempt)
        viewModelScope.launch {
            try {
                durable.await()
                requireCurrent()
                mutable.value = mutable.value.copy(persisting = false, localFailure = false)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (current())
                    mutable.value =
                        mutable.value.copy(
                            draft = attempt.copy(attempted = false),
                            phase = InstructionsPhase.Ready,
                            persisting = false,
                            localFailure = true,
                        )
                return@launch
            }
            try {
                val saved =
                    service.updatePersonalInstructions(attempt.content, attempt.base.version)
                requireCurrent()
                if (saved.content != attempt.content || saved.version == attempt.base.version)
                    throw ApiFailure.IncompatibleResponse()
                replaceDraft(null)
                requireCurrent()
                mutable.value =
                    mutable.value.copy(saved = saved, draft = null, phase = InstructionsPhase.Ready)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (!current()) return@launch
                if (error is ApiFailure.Http && error.status in setOf(400, 409)) {
                    val rejected = attempt.copy(attempted = false)
                    replaceDraft(rejected)
                    requireCurrent()
                    mutable.value =
                        mutable.value.copy(
                            draft = rejected,
                            phase =
                                if (error.status == 409) InstructionsPhase.Conflict
                                else InstructionsPhase.Ready,
                            saveRejected = error.status == 400,
                        )
                } else {
                    mutable.value = mutable.value.copy(phase = InstructionsPhase.Uncertain)
                    report(error)
                    if (!current()) return@launch
                    try {
                        val saved = service.personalInstructions()
                        requireCurrent()
                        acceptRead(saved)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (read: Exception) {
                        failRead(read)
                    }
                }
            }
        }
    }

    private fun failRead(error: Exception) {
        if (!current()) return
        report(error)
        if (!current()) return
        mutable.value =
            mutable.value.copy(
                phase =
                    if (error is ApiFailure.Http && error.status in setOf(403, 404))
                        InstructionsPhase.Unavailable
                    else if (mutable.value.draft?.attempted == true) InstructionsPhase.Uncertain
                    else InstructionsPhase.Failed,
                recoveryVersion = null,
            )
    }

    private fun report(error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            onFailure(error)
    }

    override fun onCleared() {
        retired = true
    }
}
