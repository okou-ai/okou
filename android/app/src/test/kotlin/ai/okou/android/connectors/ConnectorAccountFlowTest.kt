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
import androidx.compose.ui.test.getUnclippedBoundsInRoot
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
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private const val LOAD_WHEN_ONLINE = "Content will load when you’re back online."
private const val OFFLINE_ACCOUNT_ACTION = "Connect to the internet to manage accounts."

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
    fun directoryShowsOfflineLoadingOnlyForTabsWithoutCachedResults() =
        withDirectory(initiallyOnline = false) { fixture, connectivity ->
            val waiting =
                compose.onNode(
                    hasText(LOAD_WHEN_ONLINE) and hasAnyAncestor(hasTestTag("connector-directory"))
                )
            val offline = compose.onNodeWithText("Offline")
            val empty = "No accounts connected yet"
            waiting.assertIsDisplayed().assertHeightIsAtLeast(48.dp)
            offline.assertDoesNotExist()
            compose.onNodeWithText("Connected").performClick()
            waiting.assertIsDisplayed()
            compose.onNodeWithText(empty).assertDoesNotExist()

            fixture.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
            fixture.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
            fixture.removeAccount(CONNECTOR_SLACK_ACCOUNT)
            compose.runOnIdle { connectivity.value = true }
            awaitText(empty)
            waiting.assertDoesNotExist()
            compose.onNodeWithText("Discover").performClick()
            awaitText("Google Calendar")

            compose.runOnIdle { connectivity.value = false }
            awaitText("Offline")
            compose.onNodeWithText("Google Calendar").assertIsDisplayed()
            compose.onNodeWithText("Connected").performClick()
            compose.onNodeWithText(empty).assertIsDisplayed()
            offline.assertIsDisplayed()
            waiting.assertDoesNotExist()

            compose.onNodeWithContentDescription("Filter by service category").performClick()
            compose.onNodeWithText("Email").performClick()
            val categoryEmpty = compose.onNodeWithText("No connectors in this category")
            categoryEmpty.assertIsDisplayed()
            offline.assertIsDisplayed()
            waiting.assertDoesNotExist()

            compose.runOnIdle { connectivity.value = true }
            compose.waitUntilDoesNotExist(hasText("Offline"), 10_000)
            categoryEmpty.assertIsDisplayed()
            compose.onNodeWithText("Clear category filter").performClick()
            compose.onNodeWithText(empty).assertIsDisplayed()
        }

    @Test
    fun uncachedAccountsAndPermissionsLoadInPlaceAfterReconnect() =
        withDirectory { _, connectivity ->
            awaitText("Gmail")
            compose.runOnIdle { connectivity.value = false }
            awaitText("Offline")
            compose.onNodeWithTag("connector-gmail").performClick()
            compose.onNodeWithText("Gmail").assertIsDisplayed()
            compose.onNodeWithText(LOAD_WHEN_ONLINE).assertIsDisplayed()
            compose.onNodeWithText("Connect account").assertDoesNotExist()
            val offlineAction = compose.onNodeWithText(OFFLINE_ACCOUNT_ACTION)
            offlineAction.assertDoesNotExist()

            compose.runOnIdle { connectivity.value = true }
            awaitText("Connect account")
            compose.onNodeWithText(LOAD_WHEN_ONLINE).assertDoesNotExist()
            val permissions = "Permissions this service can request"
            awaitText(permissions)
            compose.runOnIdle { connectivity.value = false }
            awaitText(OFFLINE_ACCOUNT_ACTION)
            val connect = compose.onNodeWithText("Connect account").assertIsNotEnabled()
            assertEquals(
                8.dp,
                offlineAction.getUnclippedBoundsInRoot().top -
                    connect.getUnclippedBoundsInRoot().bottom,
            )
            compose.onNodeWithText(permissions).performClick()
            val inSheet = hasAnyAncestor(hasTestTag("connector-sheet"))
            compose.onNode(hasText(LOAD_WHEN_ONLINE) and inSheet).assertIsDisplayed()
            compose.onNode(hasText("Offline") and inSheet).assertDoesNotExist()

            compose.runOnIdle { connectivity.value = true }
            awaitText("读取邮件")
            compose.onNodeWithText(LOAD_WHEN_ONLINE).assertDoesNotExist()
            offlineAction.assertDoesNotExist()
        }

    @Test
    fun unavailableServicePermissionPanelCanCloseAfterItsLaunchControlDisappears() =
        withDirectory(initiallyOnline = false) { fixture, connectivity ->
            fixture.authorizeGmail()
            compose.runOnIdle { connectivity.value = true }
            awaitText("Gmail")
            compose.onNodeWithTag("connector-gmail").performClick()
            awaitText("gmail@example.com")
            val permissions = "Permissions this service can request"
            awaitText(permissions)
            compose.onNodeWithText(permissions).performClick()
            awaitText("读取邮件")

            compose.runOnIdle { connectivity.value = false }
            awaitText("Offline")
            fixture.unavailableCatalogSlugs = setOf("gmail")
            compose.runOnIdle { connectivity.value = true }
            awaitText("Could not load permissions.")
            awaitText("Could not load connectors.")
            compose.onNodeWithText("读取邮件").assertDoesNotExist()
            compose.onNodeWithText("Close").performClick()
            compose.onNodeWithText("gmail@example.com").assertIsDisplayed()
            compose.onNodeWithText(permissions).assertDoesNotExist()
        }

    @Test
    fun connectedCategoryFindsAccountsOutsideTheDefaultBrowseSnapshot() =
        withDirectory(initiallyOnline = false) { fixture, connectivity ->
            fixture.omittedFromDefaultBrowse = setOf("gmail")
            fixture.authorizeGmail()
            compose.runOnIdle { connectivity.value = true }
            awaitText("Google Calendar")
            compose.onNodeWithText("Connected").performClick()
            awaitText("Gmail")

            val releaseCategory = CountDownLatch(1)
            fixture.discoveryGate = releaseCategory
            try {
                compose.onNodeWithContentDescription("Filter by service category").performClick()
                compose.onNodeWithText("Email").performClick()
                compose.onNodeWithText("No connectors in this category").assertDoesNotExist()
            } finally {
                releaseCategory.countDown()
            }
            awaitText("Gmail")
            compose.onNodeWithTag("connector-search").performTextReplacement("gmail@example.com")
            compose.onNodeWithTag("connector-gmail").assertIsDisplayed()
            compose.onNodeWithTag("connector-$CONNECTOR_CALENDAR").assertDoesNotExist()
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
    fun renameComparesTrimmedNamesAndExplainsInvalidInput() = withCalendar { _, _ ->
        compose.onNodeWithText("工作日历").performClick()
        compose.onNodeWithText("Rename").performClick()
        compose
            .onNodeWithText("Leading and trailing spaces are removed. The character limit is 255.")
            .assertIsDisplayed()
        val input = compose.onNodeWithTag("connector-input")
        val save = compose.onNodeWithText("Save")
        input.performTextReplacement("  工作日历  ")
        save.assertIsNotEnabled()
        input.performTextReplacement("   ")
        save.performClick()
        compose.onNodeWithText("Enter an account name.").assertIsDisplayed()
        input.assertIsFocused()
        input.performTextReplacement("x".repeat(256))
        save.performClick()
        compose
            .onNodeWithText("The account name exceeds the character limit of 255.")
            .assertIsDisplayed()
        input.performTextReplacement("  Meeting calendar  ")
        save.performClick()
        awaitText("Meeting calendar")
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

    private fun withCalendar(exercise: (ConnectorApiFixture, MutableStateFlow<Boolean>) -> Unit) =
        withDirectory { fixture, connectivity ->
            awaitText("Google Calendar")
            compose.onNodeWithTag("connector-$CONNECTOR_CALENDAR").performClick()
            awaitText("Permission update required")
            exercise(fixture, connectivity)
        }

    private fun withDirectory(
        initiallyOnline: Boolean = true,
        exercise: (ConnectorApiFixture, MutableStateFlow<Boolean>) -> Unit,
    ) {
        ConnectorApiFixture().use { fixture ->
            val store = ViewModelStore()
            val connectivity = MutableStateFlow(initiallyOnline)
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
