package ai.okou.android.instructions

import ai.okou.android.api.generated.PersonalInstructions

enum class InstructionsPhase {
    Idle,
    Loading,
    Ready,
    Saving,
    Failed,
    Unavailable,
}

enum class InstructionsRequest {
    None,
    Reading,
    Refreshing,
    Preparing,
    Sending,
}

enum class InstructionsRead {
    Idle,
    Ready,
    RefreshFailed,
    Failed,
    Unavailable,
}

enum class InstructionsPersistence {
    Durable,
    Pending,
    Failed,
}

/** Request progress is independent of durable intent and knowledge of a remote write. */
data class PersonalInstructionsState(
    val request: InstructionsRequest = InstructionsRequest.None,
    val read: InstructionsRead = InstructionsRead.Idle,
    val saved: PersonalInstructions? = null,
    val draft: InstructionsDraft? = null,
    internal val draftRevision: Long = 0,
    val persistence: InstructionsPersistence = InstructionsPersistence.Durable,
    val saveRejected: Boolean = false,
    val saveConfirmed: Boolean = false,
) {
    val content: String
        get() = draft?.content ?: saved?.content.orEmpty()

    val busy: Boolean
        get() = request != InstructionsRequest.None

    val persisting: Boolean
        get() = persistence == InstructionsPersistence.Pending

    val localFailure: Boolean
        get() = persistence == InstructionsPersistence.Failed

    val phase: InstructionsPhase
        get() =
            when {
                request == InstructionsRequest.Reading -> InstructionsPhase.Loading
                request == InstructionsRequest.Preparing ||
                    request == InstructionsRequest.Sending -> InstructionsPhase.Saving
                read == InstructionsRead.Unavailable -> InstructionsPhase.Unavailable
                read == InstructionsRead.Failed -> InstructionsPhase.Failed
                read == InstructionsRead.Idle -> InstructionsPhase.Idle
                else -> InstructionsPhase.Ready
            }

    val canEdit: Boolean
        get() =
            (request == InstructionsRequest.None || request == InstructionsRequest.Refreshing) &&
                read != InstructionsRead.Unavailable &&
                (saved != null || draft != null)

    val canSave: Boolean
        get() =
            canEdit &&
                (read == InstructionsRead.Ready || read == InstructionsRead.RefreshFailed) &&
                draft != null &&
                saved != null &&
                draft.content != saved.content &&
                !draft.content.contains('\u0000')

    val saveInProgress: Boolean
        get() = phase == InstructionsPhase.Saving
}
