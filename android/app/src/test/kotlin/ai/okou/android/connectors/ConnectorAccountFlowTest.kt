package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.CONNECTOR_CALENDAR_SECONDARY
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w412dp-h892dp", application = TestOkouApplication::class)
class ConnectorAccountFlowTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun removingTheTargetAccountDoesNotTurnReauthorizationIntoAdd() = withCalendar { fixture, _ ->
        compose.onNodeWithText("协作日历").performClick()
        compose.onNodeWithText("Update permissions").performClick()
        compose.onNodeWithText("Continue to provider").assertIsEnabled()

        fixture.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
        compose.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)

        awaitText("Authorization is unavailable for this account.")
        compose.onNodeWithText("Continue to provider").assertDoesNotExist()
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithText("工作日历").assertExists()
    }

    @Test
    fun anUnconfirmedRenameCanBeDismissedAndStillReconcilesOnReconnect() =
        withCalendar { fixture, connectivity ->
            val pending = "The outcome is unconfirmed. Okou will check the account again."
            compose.onNodeWithText("工作日历").performClick()
            compose.onNodeWithText("Rename").performClick()
            compose.onNodeWithTag("connector-input").performTextReplacement("Meeting calendar")
            fixture.loseRenameReply = true
            fixture.failAccountReads = true
            compose.onNodeWithText("Save").performClick()

            awaitText(pending)
            compose.runOnIdle { connectivity.value = false }
            compose.onNodeWithText("Cancel").assertIsEnabled().performClick()
            compose.onNodeWithText("Rename account").assertDoesNotExist()
            compose.onNodeWithText("Rename").assertIsNotEnabled()
            compose.onNodeWithText(pending).assertExists()

            fixture.failAccountReads = false
            compose.runOnIdle { connectivity.value = true }
            awaitText("Meeting calendar")
            compose.waitUntilAtLeastOneExists(hasText("Rename") and isEnabled(), 10_000)
        }

    private fun withCalendar(exercise: (ConnectorApiFixture, MutableStateFlow<Boolean>) -> Unit) {
        ConnectorApiFixture().use { fixture ->
            val store = ViewModelStore()
            val connectivity = MutableStateFlow(true)
            try {
                val model =
                    compose.runOnIdle {
                        ViewModelProvider.create(
                                store,
                                viewModelFactory {
                                    initializer {
                                        ConnectorModel(fixture.service, connectivity, { true }) {
                                            error ->
                                            throw AssertionError(
                                                "Unexpected session failure",
                                                error,
                                            )
                                        }
                                    }
                                },
                            )[ConnectorModel::class]
                    }
                compose.setContent { OkouTheme(false) { ConnectorsPage(model, null) {} } }
                awaitText("Google Calendar")
                compose.onNodeWithTag("connector-$CONNECTOR_CALENDAR").performClick()
                awaitText("Permission update required")
                exercise(fixture, connectivity)
            } finally {
                compose.runOnIdle { store.clear() }
            }
        }
    }

    private fun awaitText(text: String) {
        compose.waitUntilAtLeastOneExists(hasText(text), 10_000)
    }
}
