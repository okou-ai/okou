package ai.okou.android.chat

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w320dp-h440dp", application = TestOkouApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SearchWorkflowIntroTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun longWorkflowTitleScrollsToTheUseActionAtLargeFontScale() {
        val workflow =
            SearchWorkflowHit(
                id = "00000000-0000-4000-8000-000000000001",
                name = "daily-operations",
                displayName = "汇总各地区团队每日运营进展和待跟进事项，生成工作区协作简报。".repeat(8),
                description = "Summarize new items from the shared workspace.",
                canUse = true,
            )
        var used = false
        compose.setContent {
            val density = Density(LocalDensity.current.density, fontScale = 2f)
            CompositionLocalProvider(LocalDensity provides density) {
                OkouTheme(false) {
                    SearchWorkflowIntro(
                        workflow,
                        canStartDraft = true,
                        pending = false,
                        failed = false,
                        onClose = {},
                        onUse = { used = true },
                        onOpenDetails = {},
                    )
                }
            }
        }

        compose.onNodeWithText(workflow.title).assertIsDisplayed()
        val viewport = compose.onNode(hasScrollAction()).getUnclippedBoundsInRoot()
        assertTrue(
            "The workflow introduction must have a scrollable viewport",
            viewport.bottom > viewport.top,
        )
        compose
            .onNodeWithText("Add to new chat draft")
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        compose.runOnIdle { assertTrue(used) }
    }
}
