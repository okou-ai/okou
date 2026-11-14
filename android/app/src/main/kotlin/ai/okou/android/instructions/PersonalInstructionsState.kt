package ai.okou.android.instructions

import ai.okou.android.api.generated.PersonalInstructions

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

enum class InstructionsRequest {
    None,
    Reading,
    Preparing,
    Sending,
}

enum class InstructionsRead {
    Idle,
    Ready,
    Failed,
    Unavailable,
}

enum class InstructionsPersistence {
    Durable,
    Pending,
    Failed,
}

enum class InstructionsRejection {
    None,
    Invalid,
    Conflict,
}

/** Request progress is independent of durable intent and knowledge of a remote write. */
data class PersonalInstructionsState(
    val request: InstructionsRequest = InstructionsRequest.None,
    val read: InstructionsRead = InstructionsRead.Idle,
    val saved: PersonalInstructions? = null,
    val draft: InstructionsDraft? = null,
    val persistence: InstructionsPersistence = InstructionsPersistence.Durable,
    val rejection: InstructionsRejection = InstructionsRejection.None,
    val recoveryVersion: String? = null,
) {
    val content: String
        get() = draft?.content ?: saved?.content.orEmpty()

    val busy: Boolean
        get() = request != InstructionsRequest.None

    val persisting: Boolean
        get() = persistence == InstructionsPersistence.Pending

    val localFailure: Boolean
        get() = persistence == InstructionsPersistence.Failed

    val saveRejected: Boolean
        get() = rejection == InstructionsRejection.Invalid

    val conflicting: Boolean
        get() =
            rejection == InstructionsRejection.Conflict ||
                draft != null && saved != null && draft.base.version != saved.version

    val phase: InstructionsPhase
        get() =
            when {
                request == InstructionsRequest.Reading -> InstructionsPhase.Loading
                busy -> InstructionsPhase.Saving
                read == InstructionsRead.Unavailable -> InstructionsPhase.Unavailable
                draft?.attempted == true -> InstructionsPhase.Uncertain
                read == InstructionsRead.Failed -> InstructionsPhase.Failed
                read == InstructionsRead.Idle -> InstructionsPhase.Idle
                conflicting -> InstructionsPhase.Conflict
                else -> InstructionsPhase.Ready
            }

    val canEdit: Boolean
        get() =
            !busy &&
                read !in setOf(InstructionsRead.Idle, InstructionsRead.Unavailable) &&
                (saved != null || draft != null) &&
                draft?.attempted != true

    val canSave: Boolean
        get() =
            !busy &&
                read == InstructionsRead.Ready &&
                !conflicting &&
                draft != null &&
                !draft.attempted &&
                !content.contains('\u0000')

    val canRetrySave: Boolean
        get() =
            !busy &&
                read != InstructionsRead.Unavailable &&
                draft?.attempted == true &&
                recoveryVersion == draft.base.version
}
