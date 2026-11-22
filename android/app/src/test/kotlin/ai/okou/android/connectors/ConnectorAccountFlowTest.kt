package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.CONNECTOR_CALENDAR_PRIMARY
import ai.okou.android.CONNECTOR_CALENDAR_SECONDARY
import ai.okou.android.CONNECTOR_SLACK_ACCOUNT
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isOff
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.platform.app.InstrumentationRegistry
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
    fun loadingRowsStayHiddenDuringTheInitialReadGracePeriod() {
        compose.mainClock.autoAdvance = false
        try {
            compose.setContent { OkouTheme(false) { ConnectorSkeleton("Loading connectors", 1) } }
            val skeleton = compose.onNodeWithContentDescription("Loading connectors")
            compose.mainClock.advanceTimeBy(80)
            skeleton.assertDoesNotExist()
            compose.mainClock.advanceTimeBy(64)
            skeleton.assertIsDisplayed()
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    @Test
    fun directoryControlsKeepKeyboardFocusWhenCachedResultsRefresh() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            withCalendar { fixture, connectivity ->
                compose.onNodeWithContentDescription("Back").performClick()
                val discover = compose.onNodeWithText("Discover")
                val connected = compose.onNodeWithText("Connected")
                discover.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
                discover.performKeyInput { pressKey(Key.DirectionRight) }
                connected.assertIsSelected().assertIsFocused()
                val slack = compose.onNodeWithTag("connector-slack").assertIsDisplayed()

                compose.runOnIdle { connectivity.value = false }
                awaitText("Offline")
                connected.assertIsFocused()
                slack.assertIsDisplayed()

                val category = compose.onNodeWithContentDescription("Filter by service category")
                category.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
                fixture.removeAccount(CONNECTOR_SLACK_ACCOUNT)
                compose.runOnIdle { connectivity.value = true }
                compose.waitUntilDoesNotExist(hasTestTag("connector-slack"), 10_000)
                category.assertIsFocused().assertIsEnabled()
                connected.assertIsSelected()

                val search = compose.onNodeWithTag("connector-search")
                search.performTextReplacement("Missing service")
                compose.onNodeWithText("Clear search").performClick()
                search.assertIsFocused()
                connected.assertIsSelected()
                compose.onNodeWithTag("connector-$CONNECTOR_CALENDAR").assertIsDisplayed()
            }
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun changingTheDefaultSwitchUpdatesTheAccountRow() = withCalendar { _, _ ->
        compose.onNodeWithText("工作日历").performClick()
        val toggleLabel = "Enable by default"
        compose.onNodeWithText(toggleLabel).assertHeightIsAtLeast(56.dp).assertIsOn().performClick()
        compose.waitUntilAtLeastOneExists(hasText(toggleLabel) and isOff(), 10_000)
        compose
            .onNode(
                hasText("Connected") and
                    hasAnyAncestor(hasTestTag("connector-account-$CONNECTOR_CALENDAR_PRIMARY")),
                useUnmergedTree = true,
            )
            .assertExists()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun accountPanelUsesTheSharedWideWidth() = withCalendar { _, _ ->
        compose.onNodeWithText("工作日历").performClick()
        compose.onNodeWithTag("connector-sheet").assertIsDisplayed().assertWidthIsEqualTo(460.dp)
        compose.onNodeWithText("Enable by default").assertIsOn()
    }

    @Test
    fun removingTheTargetAccountDoesNotTurnReauthorizationIntoAdd() = withCalendar { fixture, _ ->
        compose.onNodeWithText("协作日历").performClick()
        compose.onNodeWithText("Update permissions").performClick()
        compose.onNodeWithText("Continue to provider").assertIsEnabled()

        fixture.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
        compose.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)

        awaitText("This account is no longer available.")
        compose.onNodeWithText("Continue to provider").assertDoesNotExist()
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithText("工作日历").assertExists()
    }

    @Test
    fun removingTheAccountWhileRenamingLeavesADismissibleExplanation() =
        withCalendar { fixture, _ ->
            compose.onNodeWithText("工作日历").performClick()
            compose.onNodeWithText("Rename").performClick()
            compose.onNodeWithText("Rename account").assertIsDisplayed()

            fixture.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
            compose.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)

            awaitText("This account is no longer available.")
            compose.onNodeWithText("Rename account").assertDoesNotExist()
            compose.onNodeWithText("Close").performClick()
            compose.onNodeWithText("协作日历").assertIsDisplayed()
        }

    @Test
    fun removingAnAccountDoesNotCarryItsDisconnectConfirmationToAnotherAccount() =
        withCalendar { fixture, _ ->
            val confirmation = "Disconnect this account?"
            compose.onNodeWithText("工作日历").performClick()
            compose.onNodeWithText("Disconnect account").performClick()
            compose.onNodeWithText(confirmation).assertIsDisplayed()

            compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            fixture.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            awaitText("This account is no longer available.")
            compose.onNodeWithText("Close").performClick()

            compose.onNodeWithText("协作日历").performClick()
            compose.onNodeWithText("Update permissions").assertIsEnabled()
            compose.onNodeWithText(confirmation).assertDoesNotExist()
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
