package ai.okou.android.chat

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.Indicators
import ai.okou.android.chatEventWire
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
internal class ChatListReadScopeModelTest : ChatListModelTestFixture() {
    @Test
    fun backgroundingCancelsBothInFlightRequestsAndResumesWithConfirmedContent() = runTest {
        val service = Service()
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            val cached = model.uiState.value
            assertFalse(cached.threads.isEmpty())
            val cancelled = mutableSetOf<String>()
            val releaseCancelledIndicator = CompletableDeferred<Unit>()

            service.listRead = {
                try {
                    awaitCancellation()
                } finally {
                    cancelled.add("list")
                }
            }
            service.statusRead = {
                try {
                    awaitCancellation()
                } finally {
                    cancelled.add("indicators")
                    withContext(NonCancellable) { releaseCancelledIndicator.await() }
                }
            }
            model.refresh()
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)

            model.activityForegroundChanged(false)
            runCurrent()
            val returnedUnread = mapOf(CHAT_PERSONAL to CHAT_DATE)
            try {
                assertEquals(setOf("list", "indicators"), cancelled)
                assertEquals(cached.threads, model.uiState.value.threads)
                assertEquals(cached.indicators, model.uiState.value.indicators)

                service.listRead = { page(emptyList()) }
                service.statusRead = { Indicators(emptyMap(), returnedUnread) }
                model.activityForegroundChanged(true)
                runCurrent()
                assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
                assertEquals(cached.indicators, model.uiState.value.indicators)
            } finally {
                releaseCancelledIndicator.complete(Unit)
            }
            runCurrent()
            assertEquals(ChatReadPhase.Ready, model.uiState.value.indicatorsPhase)
            assertEquals(cached.threads, model.uiState.value.threads)
            assertEquals(returnedUnread, model.uiState.value.displayUnreadAt)
        }
    }

    @Test
    fun explicitCatchUpCanReadWhileTheAutomaticListScopeIsClosed() = runTest {
        val service = Service()
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            model.listVisibilityChanged(false)
            var reads = 0
            service.listRead = {
                reads++
                page(
                    listOf(
                        chatEventWire(
                            id = "77777777-7777-4777-8777-777777777777",
                            seq = 18,
                            thread = CHAT_IN_PROJECT,
                        ),
                    ),
                )
            }
            model.refreshList()
            runCurrent()
            assertEquals(0, reads)
            assertTrue(model.resolveSearchChats(setOf(CHAT_IN_PROJECT)).isEmpty())
            assertEquals(1, reads)
        }
    }
}
