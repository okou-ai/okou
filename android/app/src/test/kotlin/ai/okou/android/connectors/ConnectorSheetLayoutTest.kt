package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_EXAMPLE_DEVICE_CODE
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
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
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun deviceSetupRequiresACurrentCatalogChoiceBeforeRequestingACode() {
        ConnectorApiFixture(includeGrantExamples = true, requireDeviceEnvironment = true).use {
            fixture ->
            val store = ViewModelStore()
            try {
                val model = compose.runOnIdle {
                    ViewModelProvider.create(
                            store,
                            viewModelFactory {
                                initializer {
                                    ConnectorModel(fixture.service, { true }) {
                                        throw AssertionError(it)
                                    }
                                }
                            },
                        )[ConnectorModel::class]
                }
                compose.setContent { OkouTheme(false) { ConnectorsPage(model, null) {} } }
                compose
                    .onNodeWithTag("connector-search")
                    .performTextReplacement("Device authorization")
                val service = "Device authorization sample"
                compose.waitUntilAtLeastOneExists(hasText(service), 10_000)
                compose.onNodeWithText(service).performClick()
                compose.waitUntilAtLeastOneExists(hasText("Connect account"), 10_000)
                compose.onNodeWithText("Connect account").performClick()
                val submit = compose.onNodeWithText("Continue to provider")
                submit.assertIsNotEnabled()
                compose
                    .onNodeWithText("Live workspace")
                    .assertHeightIsAtLeast(56.dp)
                    .performClick()
                    .assertIsSelected()
                submit.assertIsEnabled()

                fixture.offerLiveDeviceEnvironment = false
                compose.runOnIdle { model.resume() }
                compose.waitUntilDoesNotExist(hasText("Live workspace"), 10_000)
                submit.assertIsNotEnabled()
                compose.onNodeWithText("Test workspace").performClick().assertIsSelected()
                submit.assertIsEnabled().performClick()
                compose.waitUntilAtLeastOneExists(hasText(CONNECTOR_EXAMPLE_DEVICE_CODE), 10_000)
                assertEquals(1, fixture.deviceStartRequests.get())
            } finally {
                compose.runOnIdle { store.clear() }
            }
        }
    }

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
