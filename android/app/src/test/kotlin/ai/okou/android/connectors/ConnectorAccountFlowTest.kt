package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.CONNECTOR_CALENDAR_PRIMARY
import ai.okou.android.CONNECTOR_CALENDAR_SECONDARY
import ai.okou.android.CONNECTOR_SLACK_ACCOUNT
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isOff
import androidx.compose.ui.test.junit4.StateRestorationTester
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
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private const val NETWORK_ACTION_FAILURE =
    "Could not reach Okou. Check your connection and try again."

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
            compose.mainClock.advanceTimeBy(224)
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
            withCalendar { fixture, model ->
                val description = compose.onNodeWithText("查看日程、查找空闲时间和创建会议。")
                val accounts = compose.onNodeWithText("Accounts")
                assertEquals(
                    33.dp,
                    accounts.getUnclippedBoundsInRoot().top -
                        description.getUnclippedBoundsInRoot().bottom,
                )
                compose.onNodeWithContentDescription("Back").performClick()
                val discover = compose.onNodeWithText("Discover")
                val connected = compose.onNodeWithText("Connected")
                discover.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
                discover.performKeyInput { pressKey(Key.DirectionRight) }
                connected.assertIsSelected().assertIsFocused()
                val slack = compose.onNodeWithTag("connector-slack").assertIsDisplayed()
                val directory = compose.onNodeWithTag("connector-directory")
                val directoryBounds = directory.getUnclippedBoundsInRoot()

                compose.runOnIdle { model.pause() }
                connected.assertIsFocused()
                slack.assertIsDisplayed()
                assertEquals(directoryBounds, directory.getUnclippedBoundsInRoot())

                val category = compose.onNodeWithContentDescription("Filter by service category")
                category.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
                fixture.removeAccount(CONNECTOR_SLACK_ACCOUNT)
                compose.runOnIdle { model.resume() }
                compose.waitUntilDoesNotExist(hasTestTag("connector-slack"), 10_000)
                category.assertIsFocused().assertIsEnabled()
                connected.assertIsSelected()

                val search = compose.onNodeWithTag("connector-search")
                search.performTextReplacement("Missing service")
                compose.onNodeWithText("Clear search").performClick()
                search.assertIsFocused()
                connected.assertIsSelected()
                category.performClick()
                compose.onNodeWithText("Meetings and scheduling").performClick()
                search.performTextReplacement("calendar")
                val calendar = compose.onNodeWithTag("connector-$CONNECTOR_CALENDAR")
                compose.waitUntilAtLeastOneExists(
                    hasTestTag("connector-$CONNECTOR_CALENDAR"),
                    10_000,
                )
                calendar.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
                calendar.performKeyInput { pressKey(Key.Enter) }
                awaitText("Permission update required")
                compose.onNodeWithContentDescription("Back").performClick()
                calendar.assertIsDisplayed().assertIsFocused()
                search.assertTextContains("calendar")
                category.assert(
                    SemanticsMatcher.expectValue(
                        SemanticsProperties.StateDescription,
                        "Meetings and scheduling",
                    ),
                )
            }
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun wideDirectoryChangesKeepTheSelectedPreviewUntilTheDetailResponds() = withKeyboard {
        val restoration = StateRestorationTester(compose)
        withDirectory(
            listWidth = 180,
            restoration = restoration,
            configure = { it.omittedFromDefaultBrowse = setOf("gmail") },
        ) { fixture, _ ->
            awaitText("Google Calendar")

            val search = compose.onNodeWithTag("connector-search")
            search.performTextReplacement("gmail")
            val gmailRow = hasTestTag("connector-gmail")
            compose.waitUntilAtLeastOneExists(gmailRow, 10_000)
            val gmailDetail =
                compose.onNode(hasText("Gmail") and hasAnyAncestor(hasTestTag("connector-detail")))
            val releaseDetail = CountDownLatch(1)
            fixture.denyCatalogDetail = true
            fixture.detailReplyGate = releaseDetail
            try {
                val gmail = compose.onNode(gmailRow)
                gmail.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
                gmail.performKeyInput { pressKey(Key.Enter) }
                gmail.assertIsSelected().assertIsFocused()
                gmailDetail.assertIsDisplayed()

                search.performTextReplacement("calendar")
                compose.waitUntilAtLeastOneExists(
                    hasTestTag("connector-$CONNECTOR_CALENDAR"),
                    10_000,
                )
                compose.onNode(gmailRow).assertDoesNotExist()
                gmailDetail.assertIsDisplayed()

                compose.onNodeWithText("Connected").performClick()
                compose.onNodeWithContentDescription("Filter by service category").performClick()
                compose.onNodeWithText("Meetings and scheduling").performClick()
                compose.waitUntilAtLeastOneExists(
                    hasTestTag("connector-$CONNECTOR_CALENDAR"),
                    10_000,
                )
                search.assertTextContains("calendar")
                gmailDetail.assertIsDisplayed()

                restoration.emulateSavedInstanceStateRestore()
                search.assertTextContains("calendar")
                gmailDetail.assertIsDisplayed()
            } finally {
                releaseDetail.countDown()
            }

            awaitText("Could not load connectors.")
            gmailDetail.assertDoesNotExist()

            fixture.denyCatalogDetail = false
            compose.onNodeWithTag("connector-$CONNECTOR_CALENDAR").performClick()
            awaitText("Permission update required")
            gmailDetail.assertDoesNotExist()
        }
    }

    @Test
    fun directoryKeepsCachedResultsAndViewportWhenRefreshingFails() =
        withDirectory(
            configure = { fixture ->
                fixture.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
                fixture.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
                fixture.removeAccount(CONNECTOR_SLACK_ACCOUNT)
            },
        ) { fixture, model ->
            val empty = "No accounts connected yet"
            compose.onNodeWithText("Connected").performClick()
            awaitText(empty)
            compose.onNodeWithText("Discover").performClick()
            awaitText("Google Calendar")

            val directory = compose.onNodeWithTag("connector-directory")
            val calendar = compose.onNodeWithTag("connector-$CONNECTOR_CALENDAR")
            val directoryBounds = directory.getUnclippedBoundsInRoot()
            val rowBounds = calendar.getUnclippedBoundsInRoot()
            fixture.discoveryRetryAfterSeconds = 0
            fixture.failDiscovery = true
            compose.runOnIdle {
                model.pause()
                model.resume()
            }
            val feedback = hasText("Could not refresh connectors.")
            compose.waitUntilAtLeastOneExists(feedback, 10_000)
            compose
                .onNode(feedback and !hasAnyAncestor(hasTestTag("connector-directory")))
                .assertIsDisplayed()
            assertEquals(directoryBounds, directory.getUnclippedBoundsInRoot())
            assertEquals(rowBounds, calendar.getUnclippedBoundsInRoot())
            compose.onNodeWithText("Connected").performClick()
            compose.onNodeWithText(empty).assertIsDisplayed()
            compose.onNode(feedback).assertDoesNotExist()

            fixture.failDiscovery = false
            compose.onNodeWithContentDescription("Filter by service category").performClick()
            compose.onNodeWithText("Email").performClick()
            awaitText("No connectors in this category")
            compose.onNodeWithText("Clear category filter").performClick()
            compose.onNodeWithText(empty).assertIsDisplayed()
        }

    @Test
    fun uncachedAccountsAndPermissionsLoadInTheSelectedService() = withDirectory { fixture, _ ->
        awaitText("Gmail")
        val releaseDetail = CountDownLatch(1)
        fixture.detailReplyGate = releaseDetail
        try {
            compose.onNodeWithTag("connector-gmail").performClick()
            compose.onNodeWithText("Gmail").assertIsDisplayed()
            compose.onNodeWithText("Connect account").assertDoesNotExist()
        } finally {
            releaseDetail.countDown()
        }

        compose.waitUntilAtLeastOneExists(hasText("Connect account") and isEnabled(), 10_000)
        compose.onNodeWithText("Permissions this service can request").performClick()
        awaitText("读取邮件")
        compose.onNodeWithText(NETWORK_ACTION_FAILURE).assertDoesNotExist()
    }

    @Test
    fun firstAccountReadFailureAnnouncesTheErrorAndKeepsBack() = withDirectory { fixture, _ ->
        awaitText("Gmail")
        fixture.denyAccountReads = true
        compose.onNodeWithTag("connector-gmail").performClick()
        val error = "Could not load accounts."
        awaitText(error)
        compose
            .onNodeWithText(error)
            .assertWidthIsAtLeast(300.dp)
            .assert(
                SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite),
            )
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("connector-gmail").assertIsDisplayed()
    }

    @Test
    fun firstPermissionReadFailureAnnouncesTheErrorAndKeepsClose() = withDirectory { fixture, _ ->
        awaitText("Gmail")
        compose.onNodeWithTag("connector-gmail").performClick()
        val permissions = "Permissions this service can request"
        awaitText(permissions)
        fixture.denyPermissionReads = true
        compose.onNodeWithText(permissions).performClick()
        val error = "Could not load permissions."
        awaitText(error)
        compose
            .onNodeWithText(error)
            .assertWidthIsAtLeast(300.dp)
            .assert(
                SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite),
            )
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithText(permissions).assertIsDisplayed()
    }

    @Test
    fun unavailableServicePermissionPanelCanCloseAfterItsLaunchControlDisappears() =
        withDirectory(configure = { it.authorizeGmail() }) { fixture, model ->
            awaitText("Gmail")
            compose.onNodeWithTag("connector-gmail").performClick()
            awaitText("gmail@example.com")
            val permissions = "Permissions this service can request"
            awaitText(permissions)
            compose.onNodeWithText(permissions).performClick()
            awaitText("读取邮件")

            fixture.unavailableCatalogSlugs = setOf("gmail")
            compose.runOnIdle { model.resume() }
            awaitText("Could not load permissions.")
            awaitText("Could not load connectors.")
            compose.onNodeWithText("读取邮件").assertDoesNotExist()
            compose.onNodeWithText("Close").performClick()
            compose.onNodeWithText("gmail@example.com").assertIsDisplayed()
            compose.onNodeWithText(permissions).assertDoesNotExist()

            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithText("Connected").performClick()
            compose.onNodeWithTag("connector-gmail").performClick()
            compose.onNodeWithText("Could not load connectors.").assertIsDisplayed()
        }

    @Test
    fun connectedCategoryFindsAccountsOutsideTheDefaultBrowseSnapshot() =
        withDirectory(
            configure = {
                it.omittedFromDefaultBrowse = setOf("gmail")
                it.authorizeGmail()
            },
        ) { fixture, _ ->
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
    fun theDefaultSwitchAndAccountRowKeepTheirConfirmedStateUntilTheReply() =
        withCalendar { fixture, _ ->
            compose.onNodeWithText("工作日历").performClick()
            val toggleLabel = "Enable by default"
            val toggle = compose.onNodeWithText(toggleLabel)
            val account =
                hasAnyAncestor(hasTestTag("connector-account-$CONNECTOR_CALENDAR_PRIMARY"))
            val release = CountDownLatch(1)
            fixture.defaultReplyGate = release
            try {
                toggle.assertHeightIsAtLeast(56.dp).assertIsOn().performClick()
                compose.waitUntil(10_000) { fixture.defaultReplyStarted.count == 0L }
                toggle.assertIsOn().assertIsNotEnabled()
                compose
                    .onNode(
                        hasText("Connected · Enabled by default") and account,
                        useUnmergedTree = true,
                    )
                    .assertExists()
            } finally {
                release.countDown()
            }
            compose.waitUntilAtLeastOneExists(hasText(toggleLabel) and isOff(), 10_000)
            compose.onNode(hasText("Connected") and account, useUnmergedTree = true).assertExists()
        }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun accountPanelUsesTheSharedWideWidth() = withCalendar { _, _ ->
        compose.onNodeWithText("工作日历").performClick()
        compose.onNodeWithTag("connector-sheet").assertIsDisplayed().assertWidthIsEqualTo(460.dp)
        compose.onNodeWithText("Enable by default").assertIsOn()
    }

    @Test
    fun reauthorizationKeepsTheSelectedAccountFromLoadingThroughReturn() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            withDirectory { fixture, _ ->
                awaitText("Google Calendar")
                val release = CountDownLatch(1)
                fixture.detailReplyGate = release
                val onSheet = hasAnyAncestor(hasTestTag("connector-sheet"))
                val updatePermissions = compose.onNode(hasText("Update permissions") and onSheet)
                try {
                    compose.onNodeWithTag("connector-$CONNECTOR_CALENDAR").performClick()
                    awaitText("Permission update required")
                    compose
                        .onNodeWithTag("connector-account-$CONNECTOR_CALENDAR_SECONDARY")
                        .performClick()
                    updatePermissions.performClick()
                    compose
                        .onNodeWithText("Update permissions · Google Calendar")
                        .assertIsDisplayed()
                    compose.onNode(hasText("协作日历") and onSheet).assertIsDisplayed()
                    compose.onNodeWithText("Cancel").assertIsEnabled()
                    compose.onNodeWithText("Continue to provider").assertDoesNotExist()
                } finally {
                    release.countDown()
                }

                awaitText("Continue to provider")
                compose.onNodeWithText("Cancel").performClick()
                updatePermissions.assertIsEnabled().assertIsFocused()
                updatePermissions.performClick()
                compose.onNodeWithText("Continue to provider").performClick()
                awaitText("Check authorization")
                fixture.reauthorizeCalendar()
                compose.onNodeWithText("Check authorization").performClick()
                awaitText("Enable by default")
                compose.onNode(hasText("协作日历") and onSheet).assertIsDisplayed()
                compose.onNode(hasText("team@example.com") and onSheet).assertIsDisplayed()
                compose.onNodeWithText("Enable by default").assertIsFocused().assert(isOff())
                compose.onNodeWithText("Permission update required").assertDoesNotExist()
            }
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun deniedMethodsKeepTheAuthorizationPanelAndReturnToTheAccount() =
        withDirectory { fixture, _ ->
            awaitText("Google Calendar")
            fixture.denyCatalogDetail = true
            compose.onNodeWithTag("connector-$CONNECTOR_CALENDAR").performClick()
            awaitText("Permission update required")
            compose.onNodeWithText("协作日历").performClick()
            compose.onNodeWithText("Update permissions").performClick()
            compose.onNodeWithText("Update permissions · Google Calendar").assertIsDisplayed()
            compose
                .onNode(
                    hasText("Could not load connectors.") and
                        hasAnyAncestor(hasTestTag("connector-sheet")),
                )
                .assertIsDisplayed()
                .assert(
                    SemanticsMatcher.expectValue(
                        SemanticsProperties.LiveRegion,
                        LiveRegionMode.Polite,
                    ),
                )
            compose.onNodeWithText("Continue to provider").assertDoesNotExist()
            compose.onNodeWithText("Cancel").performClick()
            compose.onNodeWithText("Update permissions").assertIsEnabled()
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
        compose.onNodeWithText("Enter an account name.").assertDoesNotExist()
        val input = compose.onNodeWithTag("connector-input").performClick()
        val save = compose.onNodeWithText("Save")
        input.performTextReplacement("  工作日历  ")
        save.assertIsNotEnabled()
        input.performTextReplacement("   ")
        save.assertIsNotEnabled()
        compose.onNodeWithText("Enter an account name.").assertIsDisplayed()
        input.assertIsFocused()
        input.performTextReplacement("x".repeat(256))
        save.assertIsNotEnabled()
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
    fun aFailedRenameCanBeDismissedBeforeNormalRefreshFindsTheNewName() =
        withCalendar { fixture, model ->
            val failure = "Could not save. Your changes are still here."
            compose.onNodeWithText("工作日历").performClick()
            compose.onNodeWithText("Rename").performClick()
            compose.onNodeWithTag("connector-input").performTextReplacement("Meeting calendar")
            fixture.loseRenameReply = true
            fixture.failAccountReads = true
            compose.onNodeWithText("Save").performClick()

            awaitText(failure)
            compose.onNodeWithText("Cancel").assertIsEnabled().performClick()
            compose.onNodeWithText("Rename account").assertDoesNotExist()
            compose.onNodeWithText("Rename").assertIsEnabled()
            awaitText("工作日历")

            fixture.failAccountReads = false
            compose.runOnIdle { model.resume() }
            awaitText("Meeting calendar")
            assertEquals(1, fixture.renameRequests.get())
        }

    @Test
    fun renameShowsNetworkFailureOnlyAfterSubmitAndKeepsTheFocusedInput() =
        withCalendar { fixture, _ ->
            compose.waitUntilAtLeastOneExists(hasText("Add account") and isEnabled(), 10_000)
            compose.onNodeWithText("工作日历").performClick()
            compose.onNodeWithText("Rename").assertIsEnabled().performClick()
            val input =
                compose.onNodeWithTag("connector-input").assertHeightIsAtLeast(56.dp).performClick()
            input.performTextReplacement("Meeting calendar")
            val save = compose.onNodeWithText("Save").assertIsEnabled()
            compose.onNodeWithText(NETWORK_ACTION_FAILURE).assertDoesNotExist()

            fixture.rejectConnection = true
            save.performClick()
            awaitText(NETWORK_ACTION_FAILURE)
            input.assertIsFocused()
            awaitText("Meeting calendar")
            save.assertIsEnabled()

            fixture.rejectConnection = false
            save.performClick()
            compose.waitUntilAtLeastOneExists(hasText("Rename") and isEnabled(), 10_000)
            compose
                .onNode(
                    hasText("Meeting calendar") and hasAnyAncestor(hasTestTag("connector-sheet")),
                )
                .assertIsDisplayed()
            assertEquals(1, fixture.renameRequests.get())
        }

    @Test
    fun disconnectChecksImpactBeforeSubmitting() = withCalendar { _, _ ->
        compose.waitUntilAtLeastOneExists(hasText("Add account") and isEnabled(), 10_000)
        compose.onNodeWithText("工作日历").performClick()
        compose.onNodeWithText("Disconnect account").assertIsEnabled().performClick()

        val confirm =
            hasText("Disconnect account") and
                hasAnyAncestor(isDialog()) and
                !hasAnyAncestor(hasTestTag("connector-sheet"))
        awaitText("2 chats have explicitly selected this account.")
        compose.onNode(confirm).assertIsEnabled().performClick()
        compose.waitUntilDoesNotExist(hasText("工作日历"), 10_000)
        compose.onNodeWithText("协作日历").assertIsDisplayed()
    }

    private fun withCalendar(exercise: (ConnectorApiFixture, ConnectorModel) -> Unit) =
        withDirectory { fixture, model ->
            awaitText("Google Calendar")
            compose.onNodeWithTag("connector-$CONNECTOR_CALENDAR").performClick()
            awaitText("Permission update required")
            exercise(fixture, model)
        }

    private fun withDirectory(
        listWidth: Int? = null,
        restoration: StateRestorationTester? = null,
        configure: (ConnectorApiFixture) -> Unit = {},
        exercise: (ConnectorApiFixture, ConnectorModel) -> Unit,
    ) {
        ConnectorApiFixture().use { fixture ->
            val store = ViewModelStore()
            configure(fixture)
            try {
                val model = compose.runOnIdle {
                    ViewModelProvider.create(
                            store,
                            viewModelFactory {
                                initializer {
                                    ConnectorModel(fixture.service, { true }) { error ->
                                        throw AssertionError(
                                            "Unexpected session failure",
                                            error,
                                        )
                                    }
                                }
                            },
                        )[ConnectorModel::class]
                }
                val content: @Composable () -> Unit = {
                    OkouTheme(false) { ConnectorsPage(model, listWidth) {} }
                }
                if (restoration == null) compose.setContent(content)
                else restoration.setContent(content)
                exercise(fixture, model)
            } finally {
                compose.runOnIdle { store.clear() }
            }
        }
    }

    private fun withKeyboard(exercise: () -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            exercise()
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    private fun awaitText(text: String) {
        compose.waitUntilAtLeastOneExists(hasText(text), 10_000)
    }
}
