package ai.okou.android.connectors

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class ConnectorSheetLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    @Config(qualifiers = "en-rUS-w760dp-h892dp")
    fun bottomSheetUsesAvailableSpaceAndKeepsActionsBelowTheScrollBody() {
        showLongSheet()
        val panel = compose.onNodeWithTag("connector-sheet")
        val actions = compose.onNodeWithTag("sheet-actions")
        panel.assertWidthIsEqualTo(640.dp).assertHeightIsAtLeast(760.dp)
        val footer = actions.assertIsDisplayed().getUnclippedBoundsInRoot()
        assertEquals(22.dp, panel.getUnclippedBoundsInRoot().bottom - footer.bottom)
        compose.onNodeWithText("Permission 22").performScrollTo().assertIsDisplayed()
        assertEquals(footer, actions.getUnclippedBoundsInRoot())
    }

    @Test
    @Config(qualifiers = "en-rUS-w820dp-h440dp")
    fun shortAuthorizationUsesFullWidthAndACompactFooter() {
        showLongSheet()
        val panel = compose.onNodeWithTag("connector-sheet")
        val actions = compose.onNodeWithTag("sheet-actions")
        panel.assertWidthIsEqualTo(820.dp)
        val footer = actions.assertIsDisplayed().getUnclippedBoundsInRoot()
        assertEquals(12.dp, panel.getUnclippedBoundsInRoot().bottom - footer.bottom)
        compose.onNodeWithText("Permission 22").performScrollTo().assertIsDisplayed()
        assertEquals(footer, actions.getUnclippedBoundsInRoot())
    }

    private fun showLongSheet() {
        compose.setContent {
            OkouTheme(false) {
                ConnectorSheet(
                    title = "Connector",
                    dismiss = {},
                    expandInShortWindow = true,
                    actions = {
                        Box(Modifier.fillMaxWidth().testTag("sheet-actions")) {
                            ConnectorCloseAction({})
                        }
                    },
                ) {
                    repeat(22) { index -> Text("Permission ${index + 1}", Modifier.height(48.dp)) }
                }
            }
        }
    }
}
