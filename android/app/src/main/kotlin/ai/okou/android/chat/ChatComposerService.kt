package ai.okou.android.chat

import ai.okou.android.api.generated.AcceptedInput
import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.CreatedThread
import ai.okou.android.api.generated.SendRequestVariant1

data class InputObservation(
    val threadId: String,
    val eventId: String,
    val disposition: TextDisposition?,
)

interface ChatComposerService {
    suspend fun newChatAgent(): String?

    suspend fun createThread(request: CreateThreadRequest): CreatedThread

    suspend fun sendInput(request: SendRequestVariant1): AcceptedInput

    suspend fun observeInput(threadId: String, eventId: String): InputObservation
}
