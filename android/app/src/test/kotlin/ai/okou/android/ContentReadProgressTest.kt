package ai.okou.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ComposeUiTestConfig
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = TestOkouApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ContentReadProgressTest {
    private val motion =
        object : MotionDurationScale {
            override val scaleFactor = 1f
        }
    @get:Rule val compose = createComposeRule(ComposeUiTestConfig(motion))

    @Test
    fun interruptedFadesKeepTheSpecifiedTimingAndTheNativeIndicatorPhase() {
        val visible = mutableStateOf(false)
        val startReference = mutableStateOf(false)
        compose.setContent {
            MaterialTheme(
                colorScheme =
                    lightColorScheme(primary = Color.Black, secondaryContainer = Color.Red),
            ) {
                Column(Modifier.width(200.dp)) {
                    Box(
                        Modifier.fillMaxWidth()
                            .height(8.dp)
                            .background(Color.White)
                            .testTag("subject"),
                    ) {
                        ContentReadProgress(
                            R.string.chat_syncing,
                            visible = visible.value,
                            modifier = Modifier.testTag("bar"),
                        )
                    }
                    Box(
                        Modifier.fillMaxWidth()
                            .height(8.dp)
                            .background(Color.White)
                            .testTag("reference"),
                    ) {
                        if (startReference.value) {
                            LinearProgressIndicator(
                                Modifier.fillMaxWidth().height(4.dp),
                                strokeCap = StrokeCap.Round,
                            )
                        }
                    }
                }
            }
        }
        val subject = compose.onNodeWithTag("subject")
        val bar = compose.onNodeWithTag("bar")
        val description = compose.onNodeWithContentDescription("Syncing chats…")
        val range =
            compose.onNode(
                hasAnyAncestor(hasTestTag("subject")) and
                    SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo),
                useUnmergedTree = true,
            )

        fun opacityAtCurrentPhase(): Float {
            val actual = subject.captureToImage().toPixelMap()
            val reference = compose.onNodeWithTag("reference").captureToImage().toPixelMap()
            val y = actual.height / 4
            val opacity = 1f - (0 until actual.width).minOf { actual[it, y].blue }
            for (x in 0 until actual.width) {
                val expected = 1f - (1f - reference[x, y].red) * opacity
                assertEquals("Activity segment at x=$x", expected, actual[x, y].red, 0.035f)
            }
            return opacity
        }

        fun advance(millis: Long) {
            compose.mainClock.advanceTimeBy(millis)
            compose.waitForIdle()
        }

        fun startFade(show: Boolean): Float {
            var previous = opacityAtCurrentPhase()
            compose.runOnIdle {
                visible.value = show
                if (show) startReference.value = true
            }
            // Composition and drawing can take a frame to observe a new target. Anchor the
            // elapsed time to the first rendered step in the new direction.
            repeat(5) {
                advance(16)
                val current = opacityAtCurrentPhase()
                if (if (show) current > previous else current < previous) return previous
                previous = current
            }
            error("Fade did not start toward visible=$show")
        }

        compose.mainClock.autoAdvance = false
        try {
            assertEquals(0f, startFade(true), 0.01f)
            description.assertExists()
            range.assertExists()
            advance(32)
            val entering = opacityAtCurrentPhase()
            assertEquals("Decelerated entry at 48 ms", 0.76f, entering, 0.035f)

            // The read settles before entry completes. Its semantics end with that read.
            val exitStart = startFade(false)
            description.assertDoesNotExist()
            range.assertDoesNotExist()
            assertTrue(exitStart >= entering && exitStart < 1f)
            advance(48)
            val exiting = opacityAtCurrentPhase()
            assertEquals("Accelerated exit at 64 ms", 0.706f, exiting / exitStart, 0.035f)

            val reversal = startFade(true)
            assertTrue("Reversal starts during exit", reversal > 0f && reversal <= exiting)
            advance(32)
            val returning = opacityAtCurrentPhase()
            assertEquals(
                "Reversed entry at 48 ms",
                0.76f,
                (returning - reversal) / (1f - reversal),
                0.05f,
            )
            advance(112)
            assertEquals(1f, opacityAtCurrentPhase(), 0.01f)
            range.assertExists()

            assertEquals(1f, startFade(false), 0.01f)
            advance(128)
            assertTrue(opacityAtCurrentPhase() > 0f)
            advance(32)
            bar.assertDoesNotExist()
            assertEquals(0f, opacityAtCurrentPhase(), 0.01f)
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }
}
