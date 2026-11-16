package ai.okou.android.instructions

import ai.okou.android.api.generated.PersonalInstructions

interface PersonalInstructionsService {
    suspend fun personalInstructionsEnabled(): Boolean

    suspend fun personalInstructions(): PersonalInstructions

    suspend fun updatePersonalInstructions(content: String, ifVersion: String): PersonalInstructions
}
