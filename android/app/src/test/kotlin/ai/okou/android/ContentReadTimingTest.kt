package ai.okou.android

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class ContentReadTimingTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun confirmedEmptyContentAndTerminalFailureSuppressTheFirstReadSkeleton() {
        val rows = mutableStateOf<List<String>?>(null)
        val reading = mutableStateOf(true)
        compose.mainClock.autoAdvance = false
        compose.setContent {
            if (
                rememberContentReadSkeleton(
                    hasContent = rows.value != null,
                    awaitingRead = reading.value,
                )
            ) {
                Box(Modifier.size(24.dp).testTag("skeleton"))
            }
        }
        val skeleton = compose.onNodeWithTag("skeleton")
        compose.mainClock.advanceTimeBy(224)
        skeleton.assertDoesNotExist()

        updateRead { rows.value = emptyList() }
        compose.mainClock.advanceTimeBy(112)
        skeleton.assertDoesNotExist()

        updateRead { rows.value = null }
        compose.mainClock.advanceTimeBy(304)
        skeleton.assertExists()

        updateRead { reading.value = false }
        skeleton.assertDoesNotExist()
    }

    @Test
    fun replacingTheScopeRestartsPendingSyncFeedback() {
        val thread = mutableStateOf("first")
        val delayMillis = mutableStateOf<Long?>(200L)
        compose.mainClock.autoAdvance = false
        compose.setContent {
            val syncing = key(thread.value) { rememberContentReadFeedbackAfter(delayMillis.value) }
            if (syncing) Box(Modifier.size(24.dp).testTag("syncing"))
        }
        val syncing = compose.onNodeWithTag("syncing")
        compose.mainClock.advanceTimeBy(112)

        updateRead { thread.value = "second" }
        compose.mainClock.advanceTimeBy(128)
        syncing.assertDoesNotExist()
        compose.mainClock.advanceTimeBy(112)
        syncing.assertExists()

        updateRead { delayMillis.value = null }
        syncing.assertDoesNotExist()

        updateRead { delayMillis.value = 0L }
        syncing.assertExists()
    }

    @Test
    fun cachedContentBecomesStaleAfterTenMinutes() {
        val confirmedAt = 1_000_000L
        assertEquals(1L, contentReadStaleDelayMillis(confirmedAt, confirmedAt + 600_000L))
        assertEquals(0L, contentReadStaleDelayMillis(confirmedAt, confirmedAt + 600_001L))
    }

    private fun updateRead(change: () -> Unit) {
        // Publish the snapshot before advancing the clock with auto-advance disabled.
        compose.runOnIdle { Snapshot.withMutableSnapshot(change) }
        compose.mainClock.advanceTimeByFrame()
    }
}
