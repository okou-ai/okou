package ai.okou.android

import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.SendRequestVariant1
import ai.okou.android.chat.ChatComposerService
import ai.okou.android.chat.InputObservation

/** Existing shell/auth fixtures do not expose a remote text-write capability. */
class TestChatComposerService : ChatComposerService {
    override suspend fun newChatAgent(): String? = null

    override suspend fun createThread(
        request: CreateThreadRequest
    ): ai.okou.android.api.generated.CreatedThread = error("No command backend in this fixture")

    override suspend fun sendInput(
        request: SendRequestVariant1
    ): ai.okou.android.api.generated.AcceptedInput = error("No command backend in this fixture")

    override suspend fun observeInput(threadId: String, eventId: String): InputObservation =
        error("No command backend in this fixture")
}
