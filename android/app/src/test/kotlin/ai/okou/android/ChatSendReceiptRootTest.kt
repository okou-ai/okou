package ai.okou.android

import ai.okou.android.auth.OpeningWorkspace
import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.chat.TextDisposition
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import java.util.UUID
import java.util.concurrent.CountDownLatch
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w400dp-h800dp",
    application = ComposerRootApplication::class,
)
internal class ChatSendReceiptRootTest : ChatComposerRootTestFixture() {
    @Test
    fun firstSendKeepsItsAcknowledgedBubbleWhenQueueStatusArrivesBeforeHistory() =
        assertAcknowledgedSendStaysVisibleBeforeHistory(newChat = true)

    @Test
    fun existingChatKeepsItsAcknowledgedBubbleWhenQueueStatusArrivesBeforeHistory() =
        assertAcknowledgedSendStaysVisibleBeforeHistory(newChat = false)

    private fun assertAcknowledgedSendStaysVisibleBeforeHistory(newChat: Boolean) {
        val app = compose.activity.application as ComposerRootApplication
        val queueStatusRequested = CountDownLatch(1)
        val releaseQueueStatus = CountDownLatch(1)
        val historyRequested = CountDownLatch(1)
        val releaseHistory = CountDownLatch(1)
        val deliveredId = UUID.randomUUID().toString()
        app.fixture.beforeInputStatusReturn = {
            queueStatusRequested.countDown()
            releaseQueueStatus.await()
        }
        val api = app.fixture.chats
        api.historyCatchUp = { jsonResponse("""{"events":{},"notFoundThreads":[]}""") }
        val originalResponse = api.commandResponse
        api.commandResponse = response@{ request ->
            val url = checkNotNull(request.requestUrl)
            if (!url.encodedPath.endsWith("/event-rows")) return@response originalResponse(request)
            val (eventId, input) =
                app.fixture.inputs.entries.singleOrNull()
                    ?: return@response originalResponse(request)
            val threadId = input.getValue("threadId").jsonPrimitive.content
            val since = checkNotNull(url.queryParameter("sinceSeqId")).toLong()
            if (url.pathSegments[2] != threadId || since >= 41)
                return@response originalResponse(request)
            historyRequested.countDown()
            releaseHistory.await()
            val payload = """{"userMessage":${input.getValue("userMessage")}}"""
            val delivered =
                historyEventWire(
                    deliveredId,
                    41,
                    threadId,
                    "input.prompt",
                    payload,
                    revoke = eventId,
                )
            val events = buildList {
                if (since < 40) {
                    add(
                        historyEventWire(
                            eventId,
                            40,
                            threadId,
                            "input.prompt",
                            payload,
                            run = null,
                        ),
                    )
                }
                add(delivered)
            }
            jsonResponse(
                """{"rows":[${events.joinToString(",")}],"cursor":{"lastEventId":"$deliveredId","lastSeqId":41},"hasMore":false}""",
            )
        }
        app.contextGate.countDown()
        try {
            val title = if (newChat) "New chat" else "Personal chat"
            compose.waitUntilExactlyOneExists(hasText(title), 10_000)
            compose.onNodeWithText(title).performClick()
            captureOwners()
            val history = compose.runOnIdle {
                val session =
                    ViewModelProvider(compose.activity)[SessionModel::class.java].uiState.value
                val opening = session.opening as? OpeningWorkspace.Authorized
                checkNotNull(session.ready?.chats ?: opening?.chats).history
            }
            awaitConversation {
                editor?.uiState?.value?.journal != null &&
                    (newChat || history.uiState.value.phase == HistoryPhase.Ready)
            }
            val prompt = "Keep the acknowledged message visible"
            compose.onNodeWithTag("message_input").performTextInput(prompt)
            compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
            awaitConversation { app.fixture.inputs.size == 1 }
            val (eventId, input) = app.fixture.inputs.entries.single()
            val target = ComposerTarget(input.getValue("threadId").jsonPrimitive.content)
            messageText(eventId, prompt).assertIsDisplayed()
            messageDelivery(eventId, "Sending…").assertIsDisplayed()

            app.sendGate.countDown()
            awaitConversation {
                editor?.uiState?.value?.entry(target)?.receipt?.disposition ==
                    TextDisposition.Accepted
            }
            messageDelivery(eventId, "Sending…").assertDoesNotExist()
            val acknowledged =
                messageText(eventId, prompt).assertIsDisplayed().getUnclippedBoundsInRoot()
            compose.onNodeWithTag("open_conversation_queue").assertDoesNotExist()

            if (!newChat) {
                // The existing composer checks the last accepted send when its activity resumes.
                compose.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
                compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            }
            awaitConversation { queueStatusRequested.count == 0L && historyRequested.count == 0L }
            releaseQueueStatus.countDown()
            compose.waitUntilExactlyOneExists(hasTestTag("open_conversation_queue"), 10_000)
            compose
                .onNodeWithContentDescription(app.getString(R.string.conversation_queue_count, 1))
                .assertIsDisplayed()
            val queued = messageText(eventId, prompt).assertIsDisplayed().getUnclippedBoundsInRoot()
            assertEquals(acknowledged.left, queued.left)
            assertEquals(acknowledged.right, queued.right)
            messageDelivery(eventId, "Sending…").assertDoesNotExist()

            releaseHistory.countDown()
            compose.waitUntilExactlyOneExists(hasTestTag("message_$deliveredId"), 10_000)
            messageText(deliveredId, prompt).assertIsDisplayed()
            messageText(eventId, prompt).assertDoesNotExist()
            compose.onNodeWithTag("open_conversation_queue").assertDoesNotExist()
            assertEquals(1, app.fixture.inputs.size)
        } finally {
            releaseQueueStatus.countDown()
            releaseHistory.countDown()
        }
    }
}
