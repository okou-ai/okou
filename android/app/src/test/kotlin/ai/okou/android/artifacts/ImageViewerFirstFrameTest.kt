package ai.okou.android.artifacts

import ai.okou.android.TestOkouApplication
import ai.okou.android.state.ArtifactImageViewerState
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View.MeasureSpec
import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.test.core.app.ActivityScenario
import com.github.panpf.zoomimage.compose.rememberZoomState
import kotlinx.coroutines.test.StandardTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "mdpi", application = TestOkouApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ImageViewerFirstFrameTest {
    @Test
    fun firstFrameFitsBeforeZoomSetupRuns() {
        val effects = StandardTestDispatcher()
        val recomposer = Recomposer(effects)
        val thumbnail = Bitmap.createBitmap(160, 80, Bitmap.Config.ARGB_8888)
        val frame = Bitmap.createBitmap(240, 160, Bitmap.Config.ARGB_8888)
        try {
            thumbnail.eraseColor(Color.BLUE)
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    val view = ComposeView(activity)
                    view.setParentCompositionContext(recomposer)
                    view.setContent {
                        MaterialTheme {
                            ImageViewerPage(
                                preview = null,
                                model = null,
                                description = "Photo",
                                zoom = rememberZoomState(),
                                viewer = remember { ArtifactImageViewerState() },
                                modifier = Modifier,
                                thumbnail = thumbnail,
                            )
                        }
                    }
                    activity.setContentView(view)
                    // Draw the real composition while its LaunchedEffects are still queued.
                    view.measure(
                        MeasureSpec.makeMeasureSpec(frame.width, MeasureSpec.EXACTLY),
                        MeasureSpec.makeMeasureSpec(frame.height, MeasureSpec.EXACTLY),
                    )
                    view.layout(0, 0, frame.width, frame.height)
                    view.draw(Canvas(frame))

                    val columns =
                        (0 until frame.width).filter {
                            frame.getPixel(it, frame.height / 2) == Color.BLUE
                        }
                    val rows =
                        (0 until frame.height).filter {
                            frame.getPixel(frame.width / 2, it) == Color.BLUE
                        }
                    assertEquals((16 until 224).toList(), columns)
                    assertEquals((28 until 132).toList(), rows)
                }
            }
        } finally {
            recomposer.cancel()
            effects.scheduler.runCurrent()
            frame.recycle()
            thumbnail.recycle()
        }
    }
}
