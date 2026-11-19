package ai.okou.android.chat

import ai.okou.android.TestOkouApplication
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LongState
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.testing.TestLifecycleOwner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class ChatRunningWaveTest {
    private val scale = mutableFloatStateOf(0f)
    private val motion =
        object : MotionDurationScale {
            private var observing = false

            override val scaleFactor: Float
                get() {
                    if (!observing) {
                        // Android's first read publishes the initial system value.
                        scale.floatValue = 1f
                        observing = true
                    }
                    return scale.floatValue
                }
        }

    @get:Rule val compose = createComposeRule(effectContext = motion)

    @Test
    fun titleWaveRepeatsEveryWavelengthAndUsesTheActualRowOrder() {
        assertEquals(0.5f, checkNotNull(runningTitleWavePhase(900_000_000L, 0)), 0.001f)
        assertEquals(0.5f, checkNotNull(runningTitleWavePhase(700_000_000L, 1)), 0.001f)
        assertEquals(0.5f, checkNotNull(runningTitleWavePhase(900_000_000L, 9)), 0.001f)
        assertEquals(0f, checkNotNull(runningTitleWavePhase(1_800_000_000L, 0)), 0.001f)
        assertEquals(null, runningTitleWavePhase(STATIC_RUNNING_FRAME, 0))
    }

    @Test
    fun sharedFrameAdvancesOnlyForVisibleRunningRowsWithMotionEnabled() {
        lateinit var lifecycle: TestLifecycleOwner
        lateinit var frame: LongState
        compose.mainClock.autoAdvance = false
        compose.setContent {
            lifecycle = remember { TestLifecycleOwner(Lifecycle.State.STARTED) }
            CompositionLocalProvider(LocalLifecycleOwner provides lifecycle) {
                val list = rememberLazyListState()
                frame = rememberRunningWaveFrame(list, setOf("running"))
                LazyColumn(Modifier.height(52.dp).testTag("list"), state = list) {
                    item(key = "idle") { Spacer(Modifier.height(52.dp)) }
                    item(key = "running") { Spacer(Modifier.height(52.dp)) }
                }
            }
        }

        fun sample(): Long {
            compose.waitForIdle()
            compose.mainClock.advanceTimeBy(80)
            return compose.runOnIdle { frame.longValue }
        }

        assertEquals(STATIC_RUNNING_FRAME, sample())
        compose.onNodeWithTag("list").performScrollToIndex(1)
        val firstFrame = sample()
        assertTrue(firstFrame >= 0)
        assertTrue(sample() > firstFrame)

        compose.runOnIdle { Snapshot.withMutableSnapshot { scale.floatValue = 0f } }
        assertEquals(STATIC_RUNNING_FRAME, sample())
        compose.runOnIdle { Snapshot.withMutableSnapshot { scale.floatValue = 1f } }
        assertTrue(sample() > firstFrame)

        compose.runOnIdle { lifecycle.currentState = Lifecycle.State.CREATED }
        assertEquals(STATIC_RUNNING_FRAME, sample())
        compose.runOnIdle { lifecycle.currentState = Lifecycle.State.STARTED }
        assertTrue(sample() > firstFrame)

        compose.onNodeWithTag("list").performScrollToIndex(0)
        assertEquals(STATIC_RUNNING_FRAME, sample())
    }
}
