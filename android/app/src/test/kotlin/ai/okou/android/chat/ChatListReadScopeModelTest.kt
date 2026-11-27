package ai.okou.android.chat

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.ProjectSnapshot
import ai.okou.android.api.generated.ReadState
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
    fun theFirstProjectReadStartsInTheForegroundListScope() = runTest {
        var projectReads = 0
        val service =
            object : Service() {
                override suspend fun projectSnapshot(): ProjectSnapshot {
                    projectReads++
                    throw ApiFailure.Http(400, null, null, null)
                }
            }
        withCatchUpModel(service) { model ->
            model.activityForegroundChanged(false)
            model.refresh()
            runCurrent()
            assertEquals(0, projectReads)

            model.activityForegroundChanged(true)
            runCurrent()
            val state = model.uiState.value
            assertEquals(1, projectReads)
            assertEquals(ChatReadPhase.Failed, state.projectsPhase)
            assertTrue(state.projectList.refreshFailureOrder != null)
        }
    }

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
    fun aCancelledListReadCannotRestoreItsRetryDeadlineAfterReopening() = runTest {
        val service = Service()
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            val obsolete = CompletableDeferred<ChatEvents>()
            service.listRead = { obsolete.await() }
            model.refreshList()
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)

            obsolete.completeExceptionally(ApiFailure.Http(503, null, null, 60))
            model.listVisibilityChanged(false)
            service.listRead = {
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
            model.listVisibilityChanged(true)
            runCurrent()

            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertTrue(model.uiState.value.threads.any { it.id == CHAT_IN_PROJECT })
        }
    }

    @Test
    fun aWriteReadbackFromBeforeBackgroundingCannotDelayTheResumedListRead() = runTest {
        val service = ArchiveService()
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()

            val readbackStarted = CompletableDeferred<Unit>()
            val readback = CompletableDeferred<Unit>()
            service.beforeEvents = {
                readbackStarted.complete(Unit)
                readback.await()
            }
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive))
            runCurrent()
            assertTrue(readbackStarted.isCompleted)

            model.activityForegroundChanged(false)
            model.activityForegroundChanged(true)
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)
            assertFalse(
                model.uiState.value.confirmedThreads.first { it.id == CHAT_PERSONAL }.archived,
            )

            service.beforeEvents = {}
            readback.completeExceptionally(ApiFailure.Http(503, null, null, 60))
            runCurrent()

            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertTrue(
                model.uiState.value.confirmedThreads.first { it.id == CHAT_PERSONAL }.archived,
            )
        }
    }

    @Test
    fun resumingQueuesFreshIndicatorsBehindAnExplicitWriteReadback() = runTest {
        val initialUnread = mapOf(CHAT_PERSONAL to CHAT_DATE)
        val updatedUnread = mapOf(CHAT_PERSONAL to "2026-11-14T00:00:00.000Z")
        val service =
            object : Service() {
                override suspend fun markRead(threadId: String) = ReadState(CHAT_DATE)
            }
        service.statusRead = { Indicators(emptyMap(), initialUnread) }
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            assertEquals(initialUnread, model.uiState.value.displayUnreadAt)

            val writeReadback = CompletableDeferred<Indicators>()
            service.statusRead = { writeReadback.await() }
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)

            model.activityForegroundChanged(false)
            service.statusRead = { Indicators(emptyMap(), updatedUnread) }
            model.activityForegroundChanged(true)
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)
            assertEquals(initialUnread, model.uiState.value.displayUnreadAt)

            writeReadback.complete(Indicators(emptyMap(), emptyMap()))
            runCurrent()
            assertEquals(ChatReadPhase.Ready, model.uiState.value.indicatorsPhase)
            assertEquals(updatedUnread, model.uiState.value.displayUnreadAt)
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
