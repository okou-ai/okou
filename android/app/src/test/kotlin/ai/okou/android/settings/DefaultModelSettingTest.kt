package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.OkouTheme
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp")
class DefaultModelSettingTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun offlineRowRecoversAndCatalogReorderRetainsKeyboardFocus() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        instrumentation.setInTouchMode(false)
        try {
            ChatListApiFixture().use { api ->
                val fixture = DefaultModelApiFixture(api)
                val model = DefaultModelSettings(scope, api.service, { true }, { throw it })
                compose.runOnIdle { model.online(false) }
                compose.setContent {
                    OkouTheme(dark = false) { Column { DefaultModelSetting(model) } }
                }

                val row = compose.onNodeWithText("Default model")
                row.assertIsDisplayed().assertHasNoClickAction()
                compose.onNodeWithText("Offline").assertIsDisplayed()
                compose.runOnIdle { model.online(true) }
                compose.waitUntil(10_000) {
                    compose.runOnIdle { model.state.value.options != null }
                }
                row.performClick()

                val gpt = compose.onNode(hasText("GPT 5.6 Sol") and isSelectable())
                val claude = compose.onNode(hasText("Claude Sonnet 5") and isSelectable())
                gpt.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
                assertTrue(
                    gpt.getUnclippedBoundsInRoot().top < claude.getUnclippedBoundsInRoot().top
                )

                compose.runOnIdle {
                    model.online(false)
                    fixture.gptSortOrder = 3
                    model.online(true)
                }
                compose.waitUntil(10_000) {
                    compose.runOnIdle {
                        model.state.value.options?.choices?.lastOrNull()?.id == "gpt-test"
                    }
                }
                assertTrue(
                    claude.getUnclippedBoundsInRoot().top < gpt.getUnclippedBoundsInRoot().top
                )
                gpt.assertIsFocused()
            }
        } finally {
            scope.cancel()
            instrumentation.resetInTouchMode()
        }
    }
}
