package ai.okou.android.settings

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import android.graphics.Insets
import android.view.View
import android.view.WindowInsets as PlatformInsets
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class, qualifiers = "en-rUS-w412dp-h892dp")
class ModelPickerSheetGestureTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun draggingFromTheTopOfALongModelListMovesTheSheetAndDismissesIt() {
        val open = mutableStateOf(true)
        val choices =
            List(40) { DefaultModelChoice("model-$it", "Model $it", true, emptyList(), null, null) }
        lateinit var activityView: View
        lateinit var dialogView: View
        var activityTop = 0
        var dialogTop = 0
        compose.setContent {
            OkouTheme(false) {
                val host = LocalView.current
                val hostTop = WindowInsets.safeDrawing.getTop(LocalDensity.current)
                SideEffect {
                    activityView = host
                    activityTop = hostTop
                }
                if (open.value) {
                    ModelPickerSheet(
                        title = "Model",
                        choices = choices,
                        selectedId = null,
                        effort = null,
                        fast = false,
                        select = {},
                        selectEffort = {},
                        selectFast = {},
                        dismiss = { open.value = false },
                    ) {
                        val view = LocalView.current
                        val top = WindowInsets.safeDrawing.getTop(LocalDensity.current)
                        SideEffect {
                            dialogView = view
                            dialogTop = top
                        }
                    }
                }
            }
        }
        val statusBarHeight = with(compose.density) { 24.dp.roundToPx() }
        compose.runOnIdle {
            val statusBars = PlatformInsets.Type.statusBars()
            val insets =
                PlatformInsets.Builder()
                    .setInsets(statusBars, Insets.of(0, statusBarHeight, 0, 0))
                    .setVisible(statusBars, true)
                    .build()
            // The modal reads the outer inset in the activity and the content inset in the dialog.
            activityView.dispatchApplyWindowInsets(insets)
            dialogView.dispatchApplyWindowInsets(insets)
        }
        compose.runOnIdle {
            assertEquals(statusBarHeight, activityTop)
            assertEquals(statusBarHeight, dialogTop)
        }
        val firstOption = compose.onNodeWithText("Auto", useUnmergedTree = true)
        val sheet = compose.onNodeWithTag("model-picker")
        firstOption.performTouchInput { down(center) }
        repeat(2) {
            firstOption.performTouchInput { moveBy(Offset(0f, 12.dp.toPx())) }
        }
        val before = sheet.getUnclippedBoundsInRoot()
        firstOption.performTouchInput { moveBy(Offset(0f, 12.dp.toPx())) }
        val after = sheet.getUnclippedBoundsInRoot()
        assertEquals(12f, (after.top - before.top).value, 1f)
        assertEquals((before.bottom - before.top).value, (after.bottom - after.top).value, 1f)
        firstOption.performTouchInput {
            repeat(16) { moveBy(Offset(0f, 24.dp.toPx())) }
            up()
        }
        sheet.assertDoesNotExist()
    }
}
