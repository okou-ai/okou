package ai.okou.android.chat

import ai.okou.android.CHAT_PERSONAL
import androidx.compose.ui.geometry.Rect
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConversationActivityTest {
    @Test
    fun refreshesOneVisibleRunAndCancelsItsRequestOnReplacement() = runTest {
        val requests = mutableListOf<Pair<String, String>>()
        val firstRunRefresh = CompletableDeferred<String>()
        var firstRunCancelled = false
        val service =
            object : ConversationHistoryService {
                override suspend fun historySnapshot(threadId: String) = error("Unexpected read")

                override suspend fun historyArchive(url: String) = error("Unexpected read")

                override suspend fun historyRows(threadId: String, cursor: HistoryCursor) =
                    error("Unexpected read")

                override suspend fun threadDetail(threadId: String) = error("Unexpected read")

                override suspend fun markRead(threadId: String) = error("Unexpected write")

                override suspend fun summarizeRunActivity(threadId: String, runId: String): String {
                    requests += threadId to runId
                    if (runId == "run-a" && requests.size == 2) {
                        try {
                            return firstRunRefresh.await()
                        } finally {
                            firstRunCancelled = true
                        }
                    }
                    return "Activity from $runId"
                }
            }
        val visit =
            ConversationReadSession(
                CHAT_PERSONAL,
                service,
                backgroundScope,
                { true },
                { null },
                { throw it },
                {},
                { null },
            )
        try {
            visit.showRunActivity("run-a")
            runCurrent()
            assertEquals(RunActivityText("run-a", "Activity from run-a"), visit.activityText.value)
            visit.showRunActivity("run-a")
            advanceTimeBy(14_999)
            assertEquals(listOf(CHAT_PERSONAL to "run-a"), requests)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(2, requests.size)

            visit.showRunActivity("run-b")
            runCurrent()
            assertTrue(firstRunCancelled)
            firstRunRefresh.complete("Old run")
            assertEquals(RunActivityText("run-b", "Activity from run-b"), visit.activityText.value)

            visit.showRunActivity(null)
            advanceTimeBy(30_000)
            assertNull(visit.activityText.value)
            assertEquals(listOf("run-a", "run-a", "run-b"), requests.map { it.second })
        } finally {
            visit.close()
        }
    }

    @Test
    fun stopUsesTheToolbarWhenAnyPartOfTheInlineTargetIsCovered() {
        val placement = ConversationStopPlacement()
        val hitArea = Rect(300f, 600f, 348f, 648f)
        placement.reportInlineSlot(hitArea)
        assertTrue(placement.inline)
        placement.onFocusChanged(inline = true, focused = true)
        placement.reportFeedbackBounds(Rect(32f, 610f, 290f, 650f))
        assertTrue(placement.inline)
        placement.reportFeedbackBounds(Rect(32f, 610f, 330f, 650f))
        assertFalse(placement.inline)
        assertEquals(false, placement.transferFocusToInline)
        placement.clearFocusTransfer()
        placement.onFocusChanged(inline = false, focused = true)
        placement.reportFeedbackBounds(null)
        assertTrue(placement.inline)
        assertEquals(true, placement.transferFocusToInline)
        placement.reportInlineSlot(null)
        assertFalse(placement.inline)
    }
}
