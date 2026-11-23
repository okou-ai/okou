package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerJournalStore
import android.os.Looper
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performFirstLinkClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

class WorkflowRootApplication : TestOkouApplication() {
    internal lateinit var fixture: WorkflowApiFixture
    val gate = CountDownLatch(1)

    override fun onCreate() {
        fixture = WorkflowApiFixture(chats = ComposerApiFixture().chats)
        fixture.beforeCatalog = { gate.await() }
        chatService = fixture.service
        composerService = fixture.service
        searchService = fixture.service
        workflows = fixture.service
        journalStore =
            ComposerJournalStore(this, noBackupFilesDir.resolve("workflow-${UUID.randomUUID()}"))
        super.onCreate()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w412dp-h840dp",
    application = WorkflowRootApplication::class,
)
class WorkflowRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app
        get() = compose.activity.application as WorkflowRootApplication

    @After
    fun tearDown() {
        val application = app
        application.gate.countDown()
        application.fixture.use {
            try {
                val jobs =
                    compose.runOnIdle {
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready
                            ?.let {
                                listOfNotNull(
                                    it.chats.viewModelScope.coroutineContext[Job],
                                    it.composer.viewModelScope.coroutineContext[Job],
                                    it.search.viewModelScope.coroutineContext[Job],
                                    it.workflows?.viewModelScope?.coroutineContext?.get(Job),
                                )
                            }
                            .orEmpty()
                    }
                compose.activityRule.scenario.close()
                compose.waitUntil(10_000) {
                    shadowOf(Looper.getMainLooper()).idle()
                    jobs.all { it.isCompleted }
                }
            } finally {
                runBlocking { checkNotNull(application.journalStore).close() }
            }
        }
    }

    @Test
    fun workflowDirectoryScopesRulesAndReturnsFromDraftWithoutSending() {
        assertFalse(app.fixture.requests.any { it.requestUrl?.encodedPath == "/api/workflows" })
        compose.onNodeWithContentDescription("Workflows").performClick()
        compose.onNodeWithTag("workflow_query").assertIsDisplayed()
        app.gate.countDown()
        waitFor("Release checklist")
        val row = compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE").getUnclippedBoundsInRoot()
        assertTrue(row.bottom - row.top >= 80.dp)
        selectScope("Workspace shared")
        compose.onNodeWithText("Release checklist").assertDoesNotExist()
        compose.onNodeWithTag("workflow_row_$WORKFLOW_SHARED").performClick()
        waitForTag("workflow_detail_title")
        val use = compose.onNodeWithTag("workflow_use").getUnclippedBoundsInRoot()
        assertTrue(use.bottom - use.top >= 48.dp)
        compose.onNodeWithText("Edit instructions").assertDoesNotExist()
        back()
        selectScope("All")
        compose.onNodeWithTag("workflow_query").performTextInput("/release-review")
        compose.onNodeWithText("Release follow-up").assertDoesNotExist()
        compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE").performClick()
        waitForTag("workflow_detail_title")
        compose.onNodeWithText("Edit instructions").performClick()
        compose.onNodeWithTag("workflow_save").assertIsNotEnabled()
        val name = compose.onNodeWithContentDescription("Display name")
        name.performTextReplacement(" ")
        compose.onNodeWithText("Enter a display name.").assertIsDisplayed()
        compose.onNodeWithTag("workflow_save").assertIsNotEnabled()
        name.performTextReplacement("x".repeat(257))
        compose.onNodeWithText("Use 256 characters or fewer.").assertIsDisplayed()
        compose.onNodeWithTag("workflow_save").assertIsNotEnabled()
        name.performTextReplacement("Release checklist")
        compose.onNodeWithText("Use 256 characters or fewer.").assertDoesNotExist()
        compose
            .onNodeWithText(
                "Review launch copy and product notes.\nCheck the website, email, and community assets."
            )
            .performTextReplacement("Confirm the release owner.")
        compose.onNodeWithTag("workflow_save").performClick()
        waitForTag("workflow_detail_title")
        compose.onNodeWithText("Confirm the release owner.").assertIsDisplayed()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        waitFor("Paused · Needs connection")
        compose.onNodeWithText("Trigger rules").assertIsDisplayed()
        compose.onNodeWithText("Time zone · Shanghai (UTC+8)").assertIsDisplayed()
        compose
            .onNode(hasText("Edit") and hasAnyAncestor(hasTestTag("workflow_rule_weekday")))
            .performClick()
        compose.onNodeWithText("Shanghai (UTC+8)").assertIsDisplayed()
        back()
        compose.onNodeWithText("Add automation").performClick()
        compose.onNodeWithText("Schedule").performClick()
        compose.onNodeWithText("Gmail message received").performClick()
        compose.onNodeWithContentDescription("Subject contains").performTextInput("Release")
        compose
            .onNodeWithText("A Gmail connection is required to save this rule.")
            .assertIsDisplayed()
        compose.onNodeWithText("View connections").assertIsDisplayed()
        compose.onNodeWithTag("workflow_save").assertIsNotEnabled()
        back()
        compose.onNodeWithText("Discard").performClick()
        compose.onNodeWithTag("workflow_toggle_weekday").performClick()
        waitFor("Enabled")
        compose.onNodeWithText(" · Shanghai (UTC+8)", substring = true).assertIsDisplayed()
        assertTrue(app.fixture.active.get())
        compose.onNodeWithTag("workflow_use").performClick()
        waitForTag("message_input")
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("/release-review Keep my existing draft")
        assertFalse(
            app.fixture.requests.any {
                it.method == "POST" &&
                    it.requestUrl?.encodedPath in setOf("/api/chat-threads", "/api/chat/events")
            }
        )
        back()
        compose.onNodeWithTag("workflow_tab_automations").assertIsSelected()
        compose.onNodeWithText("Enabled").assertIsDisplayed()
        back()
        compose.onNodeWithTag("workflow_query").assertTextContains("/release-review")
    }

    @Test
    fun selectingADetailKeepsTheUseButtonInPlaceWhileLoading() {
        val detail = CountDownLatch(1)
        app.fixture.beforeReleaseDetailRead = { detail.await() }
        val use = compose.onNodeWithTag("workflow_use")
        val pendingBounds =
            try {
                compose.onNodeWithContentDescription("Workflows").performClick()
                app.gate.countDown()
                waitFor("Release checklist")
                compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE").performClick()
                waitForTag("workflow_loading")
                use.assertIsDisplayed().assertIsNotEnabled().getUnclippedBoundsInRoot()
            } finally {
                detail.countDown()
            }

        waitForTag("workflow_detail_title")
        assertEquals(pendingBounds, use.assertIsEnabled().getUnclippedBoundsInRoot())
    }

    @Test
    fun returningFromWorkflowCreationRechecksTheFreshDirectory() {
        compose.onNodeWithContentDescription("Workflows").performClick()
        app.gate.countDown()
        waitFor("Release checklist")

        fun catalogReads() =
            app.fixture.requests.count {
                it.method == "GET" && it.requestUrl?.encodedPath == "/api/workflows"
            }

        assertEquals(1, catalogReads())
        compose.onNodeWithTag("workflow_create").performClick()
        waitForTag("message_input")
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("Help me create a private workflow.", substring = true)

        back()
        waitFor("Release checklist")
        compose.waitUntil(10_000) { catalogReads() == 2 }
    }

    @Test
    fun offlineDetailAttemptsTheDraftReadAndExplainsItsFailureBesideUse() {
        openWorkflowDetail()
        app.connectivity.value = false
        app.fixture.disconnectDraftRead = true
        val error =
            "Could not open the new chat draft. Your existing draft is preserved. Check your connection and try again."
        compose.onNodeWithText("Workflow instructions").assertIsDisplayed()
        compose.onNodeWithText(error).assertDoesNotExist()
        val use = compose.onNodeWithTag("workflow_use").assertIsEnabled()
        use.performClick()
        waitFor(error)
        val notice = compose.onNodeWithText(error).assertIsDisplayed().getUnclippedBoundsInRoot()
        val action = use.assertIsEnabled().getUnclippedBoundsInRoot()
        assertTrue(notice.bottom <= action.top)
        assertTrue(
            app.fixture.requests.any {
                it.method == "GET" && it.requestUrl?.encodedPath == "/api/chat-drafts/composer"
            }
        )
        assertEquals("Keep my existing draft", app.fixture.previousDraft)

        app.fixture.disconnectDraftRead = false
        app.connectivity.value = true
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(error).fetchSemanticsNodes().isEmpty()
        }
        compose.onNodeWithTag("message_input").assertDoesNotExist()
        use.performClick()
        waitForTag("message_input")
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("/release-review Keep my existing draft")
    }

    @Test
    fun offlineEditorAttemptsSaveAndRetainsInputAndFocusAfterTransportFailure() =
        withHardwareKeyboard {
            openWorkflowDetail()
            app.connectivity.value = false
            app.fixture.disconnectInstructionSave = true
            val original = app.fixture.instruction
            compose.onNodeWithText("Edit instructions").assertIsEnabled().performClick()
            val instruction = compose.onNodeWithContentDescription("Workflow instructions")
            instruction.performTextReplacement("Check the launch owner.")

            val error = "Connect to save. Your changes are still here."
            val save = compose.onNodeWithTag("workflow_save").assertIsEnabled()
            compose.onNodeWithText(error).assertDoesNotExist()
            val releaseSave = CountDownLatch(1)
            app.fixture.beforeInstructionSave = { releaseSave.await() }
            try {
                save
                    .performSemanticsAction(SemanticsActions.RequestFocus)
                    .assertIsFocused()
                    .performClick()
                save.assertIsNotEnabled()
            } finally {
                releaseSave.countDown()
            }
            waitFor(error)
            instruction.assertTextContains("Check the launch owner.")
            val notice = compose.onNodeWithText(error).getUnclippedBoundsInRoot()
            assertTrue(
                notice.bottom <=
                    save.assertIsEnabled().assertIsFocused().getUnclippedBoundsInRoot().top
            )
            val saves =
                app.fixture.requests.filter {
                    it.method == "PATCH" &&
                        it.requestUrl?.encodedPath == "/api/workflows/$WORKFLOW_RELEASE"
                }
            assertEquals(1, saves.size)

            app.fixture.disconnectInstructionSave = false
            app.connectivity.value = true
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(error).fetchSemanticsNodes().isEmpty()
            }
            assertEquals(original, app.fixture.instruction)
            save.performClick()
            waitForTag("workflow_detail_title")
            compose.onNodeWithText("Check the launch owner.").assertIsDisplayed()
        }

    @Test
    fun instructionConflictShowsTheServerOutcomeAndPreservesTheEdit() {
        openWorkflowDetail()
        app.fixture.instructionSaveConflict = true
        compose.onNodeWithText("Edit instructions").performClick()
        val instruction = compose.onNodeWithContentDescription("Workflow instructions")
        instruction.performTextReplacement("Check the launch owner.")
        val save = compose.onNodeWithTag("workflow_save")
        save.performClick()

        val error = "This workflow changed while saving. Your edits are preserved."
        waitFor(error)
        instruction.assertTextContains("Check the launch owner.")
        assertTrue(
            compose.onNodeWithText(error).getUnclippedBoundsInRoot().bottom <=
                save.assertIsEnabled().getUnclippedBoundsInRoot().top
        )
    }

    @Test
    fun newScheduleUsesTheLocalTimezoneBeforePreferencesSync() {
        openWorkflowDetail()
        app.connectivity.value = false
        compose.runOnIdle {
            val session = ViewModelProvider(compose.activity)[SessionModel::class.java]
            val preferences = checkNotNull(session.uiState.value.ready).preferences
            preferences.selectTimezone("Asia/Tokyo")
            assertEquals("UTC", preferences.uiState.value.confirmed.timezone)
        }
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        compose.onNodeWithText("Add automation").assertIsEnabled().performClick()

        compose.onNodeWithText("Tokyo (UTC+9)").assertIsDisplayed()
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun discardConfirmationKeepsBothActionsReachableAfterResizingAtLargeText() {
        val originalQualifiers = RuntimeEnvironment.getQualifiers()
        val originalScale = RuntimeEnvironment.getFontScale()
        try {
            openWorkflowDetail()
            compose.onNodeWithText("Edit instructions").performClick()
            val input = compose.onNodeWithContentDescription("Display name")
            input.performTextReplacement("Prepare the release")
            compose.onNodeWithText("Cancel").performClick()
            val heading = "Discard unsaved changes?"
            waitFor(heading)

            RuntimeEnvironment.setQualifiers("en-rUS-w900dp-h280dp")
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            compose.activityRule.scenario.onActivity {
                assertEquals(280, it.resources.configuration.screenHeightDp)
                assertEquals(2f, it.resources.configuration.fontScale, 0f)
            }
            waitFor(heading)
            compose.onNodeWithText(heading).assertIsDisplayed()
            compose.onNodeWithText("Discard").assertIsDisplayed()
            compose.onNodeWithText("Keep editing").assertIsDisplayed().performClick()
            input.assertTextContains("Prepare the release")

            compose.onNodeWithText("Cancel").performClick()
            compose.onNodeWithText("Discard").assertIsDisplayed().performClick()
            waitForTag("workflow_detail_title")
            compose
                .onNodeWithTag("workflow_detail_title")
                .assertTextContains(app.fixture.releaseTitle)
        } finally {
            RuntimeEnvironment.setQualifiers(originalQualifiers)
            RuntimeEnvironment.setFontScale(originalScale)
        }
    }

    @Test
    fun connectorRuleWaitsForConnectionAvailabilityBeforeEnabling() {
        val releaseConnections = CountDownLatch(1)
        app.fixture.beforeConnectionsRead = { releaseConnections.await() }
        try {
            openWorkflowDetail()
            compose.onNodeWithTag("workflow_tab_automations").performClick()
            compose.onNodeWithTag("workflow_toggle_gmail").assertIsNotEnabled()
            compose.onNodeWithText("View connections").assertDoesNotExist()
        } finally {
            releaseConnections.countDown()
        }
        waitFor("Paused · Needs connection")
        compose.onNodeWithText("View connections").assertIsEnabled()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun workspaceGithubAppCanEnableTheRuleWithoutAPersonalConnector() {
        app.fixture.githubAppInstalled = true
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        waitFor("Paused · Needs connection")
        compose.onNodeWithText("example/release").assertIsDisplayed()
        app.connectivity.value = false

        compose
            .onNodeWithTag("workflow_toggle_github")
            .assertIsDisplayed()
            .assertIsEnabled()
            .performClick()

        val enabled = hasText("Enabled") and hasAnyAncestor(hasTestTag("workflow_rule_github"))
        compose.waitUntil(10_000) { compose.onAllNodes(enabled).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(enabled).assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun personalGithubConnectorCannotEnableTheRuleWithoutAWorkspaceApp() {
        val fixture = app.fixture
        fixture.githubAppInstalled = false
        fixture.githubAccountConnected = true
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        waitFor("Paused · Needs connection")
        app.connectivity.value = false

        compose
            .onNodeWithTag("workflow_toggle_github")
            .assertIsDisplayed()
            .assertIsEnabled()
            .performClick()

        compose.waitUntil(10_000) {
            fixture.requests.any {
                it.method == "POST" &&
                    it.requestUrl?.encodedPath == "/api/workflow-automations/github/enable"
            }
        }

        val failure =
            hasText("Could not change this rule.") and
                hasAnyAncestor(hasTestTag("workflow_rule_github"))
        compose.waitUntil(10_000) { compose.onAllNodes(failure).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(failure).assertIsDisplayed()
        compose
            .onNode(hasText("Paused") and hasAnyAncestor(hasTestTag("workflow_rule_github")))
            .assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun memberCanPauseEditAndEnableTheirRuleOnASharedWorkflow() {
        app.fixture.hasSharedSchedule = true
        openWorkflowDetail(WORKFLOW_SHARED)
        compose.onNodeWithText("Edit instructions").assertDoesNotExist()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        waitFor("Weekdays at 09:00")
        compose.onNodeWithText("Add automation").assertDoesNotExist()

        val toggle = compose.onNodeWithTag("workflow_toggle_shared-weekday")
        toggle.assertIsDisplayed().assertIsEnabled().performClick()
        waitFor("Paused")
        compose
            .onNode(hasText("Edit") and hasAnyAncestor(hasTestTag("workflow_rule_shared-weekday")))
            .performClick()
        compose.onNodeWithContentDescription("Time (HH:mm)").performTextReplacement("10:00")
        compose.onNodeWithTag("workflow_save").assertIsEnabled().performClick()
        waitFor("Weekdays at 10:00")
        toggle.assertIsEnabled().performClick()
        waitFor("Enabled")
        compose.onNodeWithText("Weekdays at 10:00").assertIsDisplayed()
    }

    @Test
    fun calendarRuleComparesAndValidatesTheSavedCalendarId() {
        app.fixture.calendarId = "primary"
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        val ruleTag = "workflow_rule_calendar-created"
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithTag("workflow_toggle_calendar-created")
                .fetchSemanticsNodes()
                .any { !it.config.contains(SemanticsProperties.Disabled) }
        }
        val edit = compose.onNode(hasText("Edit") and hasAnyAncestor(hasTestTag(ruleTag)))
        val save = compose.onNodeWithTag("workflow_save")
        val calendar = compose.onNodeWithContentDescription("Calendar ID")
        edit.assertIsEnabled().performSemanticsAction(SemanticsActions.OnClick)
        waitForTag("workflow_save")
        calendar.performTextReplacement("  primary ")
        save.assertIsNotEnabled()
        back()
        save.assertDoesNotExist()

        edit.assertIsEnabled().performSemanticsAction(SemanticsActions.OnClick)
        waitForTag("workflow_save")
        val longestId = "c".repeat(1024)
        calendar.performTextReplacement(" ${longestId}x ")
        save.assertIsNotEnabled()
        compose.onNodeWithText("Use 1,024 characters or fewer.").assertIsDisplayed()
        calendar.performTextReplacement(" $longestId ")
        compose.onNodeWithText("Use 1,024 characters or fewer.").assertDoesNotExist()
        save.assertIsEnabled().performClick()
        waitForTag(ruleTag)
        assertEquals(longestId, app.fixture.calendarId)
    }

    @Test
    fun keyboardArrowsSelectAndFocusTheAdjacentDetailTabs() = withHardwareKeyboard {
        openWorkflowDetail()
        val instructions = compose.onNodeWithTag("workflow_tab_instructions")
        val automations = compose.onNodeWithTag("workflow_tab_automations")
        val history = compose.onNodeWithTag("workflow_tab_history")

        instructions.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        instructions.performKeyInput { pressKey(Key.DirectionRight) }
        automations.assertIsSelected().assertIsFocused()
        automations.performKeyInput { pressKey(Key.MoveEnd) }
        history.assertIsSelected().assertIsFocused()
        history.performKeyInput { pressKey(Key.DirectionRight) }
        instructions.assertIsSelected().assertIsFocused()
    }

    @Test
    fun returningWithAConnectedAccountKeepsFocusOnTheSameRule() = withHardwareKeyboard {
        val scenario = compose.activityRule.scenario
        app.fixture.gmailEnabled.set(true)
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        waitFor("Enabled · Needs connection")
        compose.onNodeWithTag("workflow_toggle_gmail").assertIsEnabled()
        compose
            .onNodeWithText("View connections")
            .performSemanticsAction(SemanticsActions.RequestFocus)
            .assertIsFocused()
            .performClick()

        scenario.moveToState(Lifecycle.State.STARTED)
        app.fixture.gmailConnected.set(true)
        scenario.moveToState(Lifecycle.State.RESUMED)

        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("View connections").fetchSemanticsNodes().isEmpty()
        }
        compose.onNodeWithTag("workflow_tab_automations").assertIsSelected()
        compose.onNodeWithTag("workflow_toggle_gmail").assertIsFocused()
    }

    @Test
    fun connectingAnAccountPreservesTheRuleEditorAndEnablesSave() = withHardwareKeyboard {
        val scenario = compose.activityRule.scenario
        val releaseConnections = CountDownLatch(1)
        app.fixture.beforeConnectionsRead = { releaseConnections.await() }
        val save = compose.onNodeWithTag("workflow_save")
        val connection = compose.onNodeWithText("View connections")
        val subject = compose.onNodeWithContentDescription("Subject contains")

        try {
            openWorkflowDetail()
            compose.onNodeWithTag("workflow_tab_automations").performClick()
            compose.onNodeWithText("Add automation").performClick()
            compose.onNodeWithText("Schedule").performClick()
            compose.onNodeWithText("Gmail message received").performClick()
            subject.performTextInput("Release summary")
            save.assertIsNotEnabled()
            connection.assertDoesNotExist()
        } finally {
            releaseConnections.countDown()
        }

        waitFor("View connections")
        save.assertIsNotEnabled()
        val cancelBounds = compose.onNodeWithText("Cancel").getUnclippedBoundsInRoot()
        val connectionBounds = connection.getUnclippedBoundsInRoot()
        val saveBounds = save.getUnclippedBoundsInRoot()
        assertTrue(
            cancelBounds.right < connectionBounds.left && connectionBounds.right < saveBounds.left
        )
        connection
            .performSemanticsAction(SemanticsActions.RequestFocus)
            .assertIsFocused()
            .performClick()

        scenario.moveToState(Lifecycle.State.STARTED)
        app.fixture.gmailConnected.set(true)
        scenario.moveToState(Lifecycle.State.RESUMED)

        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("View connections").fetchSemanticsNodes().isEmpty()
        }
        subject.assertTextContains("Release summary")
        save.assertIsEnabled().assertIsFocused()
    }

    @Test
    fun pendingDraftHandoffDisablesSourceNavigationAndRuleActions() {
        app.gate.countDown()
        waitFor("Personal chat")
        compose.onNodeWithContentDescription("Workflows").performClick()
        waitFor("Release checklist")
        compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE").performClick()
        waitForTag("workflow_detail_title")
        compose.onNodeWithTag("workflow_tab_history").performClick()
        val source = hasText(app.fixture.ruleTitle) and hasClickAction()
        compose.waitUntil(10_000) { compose.onAllNodes(source).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(source).assertIsEnabled()

        val requested = CountDownLatch(1)
        val releaseDraft = CountDownLatch(1)
        app.fixture.beforeDraftRead = {
            requested.countDown()
            releaseDraft.await()
        }
        try {
            compose.onNodeWithTag("workflow_use").assertIsEnabled().performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { requested.count == 0L } }
            compose.onNode(source).assertIsNotEnabled()

            compose.onNodeWithTag("workflow_tab_automations").performClick()
            compose.onNodeWithTag("workflow_toggle_weekday").assertIsNotEnabled()
            compose
                .onNode(hasText("Edit") and hasAnyAncestor(hasTestTag("workflow_rule_weekday")))
                .assertIsNotEnabled()
        } finally {
            releaseDraft.countDown()
        }
        waitForTag("message_input")
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("/release-review Keep my existing draft")
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h800dp")
    fun wideChatClosesSearchBeforeReturningToTheWorkflowTab() {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Workflows").performClick()
        waitFor("Release checklist")
        compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE").performClick()
        waitForTag("workflow_detail_title")
        val use = compose.onNodeWithTag("workflow_use").getUnclippedBoundsInRoot()
        val history = compose.onNodeWithTag("workflow_tab_history").getUnclippedBoundsInRoot()
        assertEquals(history.right, use.right)
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        compose.onNodeWithTag("workflow_use").performClick()
        waitForTag("message_input")
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("/release-review Keep my existing draft")

        compose.onNodeWithTag("workspace_search_entry").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput("Release")
        back()
        compose.onNodeWithTag("chat_search_query").assertDoesNotExist()
        compose.onNodeWithTag("message_input").assertIsDisplayed()

        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("workflow_tab_automations").assertIsSelected()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h800dp")
    fun sourceChatBackClosesFindThenReturnsThroughTheLinkToWorkflowHistory() {
        app.fixture.chats.historyReply = "[Project handoff](/chats/$CHAT_IN_PROJECT)"
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_history").performClick()
        val source = hasText(app.fixture.ruleTitle) and hasClickAction()
        compose.waitUntil(10_000) { compose.onAllNodes(source).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(source).performClick()
        waitForTag("conversation")

        val link = hasText("Project handoff", substring = true)
        compose.waitUntil(10_000) { compose.onAllNodes(link).fetchSemanticsNodes().size == 1 }
        compose.onNode(link).performFirstLinkClick()
        val inSidebar = hasAnyAncestor(hasTestTag("chat_list"))
        val linkedChat = hasText("Project chat") and !inSidebar
        compose.waitUntil(10_000) { compose.onAllNodes(linkedChat).fetchSemanticsNodes().size == 1 }
        compose.onNode(linkedChat).assertIsDisplayed()

        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        compose.onNodeWithTag("conversation_find").assertIsDisplayed()
        back()
        compose.onNodeWithTag("conversation_find").assertDoesNotExist()
        compose.onNodeWithTag("conversation").assertIsDisplayed()

        back()
        compose.onNode(hasText("Personal chat") and !inSidebar).assertIsDisplayed()

        back()
        compose.onNodeWithTag("workflow_tab_history").assertIsSelected()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h800dp")
    fun rejectedSourceChatDeletionRestoresTheRunLinkAndShowsFeedbackInHistory() {
        val requested = CountDownLatch(1)
        val releaseDelete = CountDownLatch(1)
        val workflowResponse = app.fixture.chats.commandResponse
        app.fixture.chats.commandResponse = { request ->
            if (
                request.method == "DELETE" &&
                    request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL"
            ) {
                requested.countDown()
                releaseDelete.await()
                MockResponse().setResponseCode(400)
            } else workflowResponse(request)
        }
        try {
            openWorkflowDetail()
            compose.onNodeWithTag("workflow_tab_history").performClick()
            val source = hasText(app.fixture.ruleTitle) and hasClickAction()
            compose.waitUntil(10_000) {
                compose.onAllNodes(source).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNode(source).performClick()
            waitForTag("conversation")

            compose.onNodeWithContentDescription("Chat actions").performClick()
            compose.onNodeWithText("Delete chat").performClick()
            compose.onNodeWithText("Delete").performClick()

            compose.waitUntil(10_000) { requested.count == 0L }
            compose.onNodeWithTag("workflow_tab_history").assertIsSelected()
            compose.onNodeWithTag("conversation").assertDoesNotExist()
            compose.onNode(source).assertDoesNotExist()

            releaseDelete.countDown()
            val rejected = "Could not finish changing the chat."
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(rejected).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText(rejected).assertIsDisplayed()
            compose.onNode(source).assertIsDisplayed()
        } finally {
            releaseDelete.countDown()
        }
    }

    private fun openWorkflowDetail(id: String = WORKFLOW_RELEASE) {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Workflows").performClick()
        val row = "workflow_row_$id"
        waitForTag(row)
        compose.onNodeWithTag(row).performClick()
        waitForTag("workflow_detail_title")
    }

    private fun withHardwareKeyboard(run: () -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            run()
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    private fun selectScope(label: String) =
        compose
            .onNode(
                hasText(label) and
                    SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)
            )
            .performClick()

    @Test
    fun searchWorkflowDetailsAndDraftReturnToTheSameSearch() {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        val scope = compose.onNodeWithTag("search_type_Workflows")
        val query = compose.onNodeWithTag("chat_search_query")
        scope.performClick()
        query.performTextInput("launch")
        val originalTitle = app.fixture.releaseTitle
        waitFor(originalTitle)
        compose.onNodeWithText("Official launch workflow").assertDoesNotExist()

        val catalogRequested = CountDownLatch(1)
        val releaseCatalog = CountDownLatch(1)
        app.fixture.beforeCatalog = {
            catalogRequested.countDown()
            releaseCatalog.await()
        }
        val renamed = "Launch planning"
        try {
            compose.onNodeWithText(originalTitle).performClick()
            waitFor("View workflow details")
            compose.onNodeWithText("View workflow details").performClick()
            waitForTag("workflow_detail_title")
            compose.waitUntil(5_000) { catalogRequested.count == 0L }
            compose.onNodeWithText("Edit instructions").performClick()
            compose.onNodeWithText(originalTitle).performTextReplacement(renamed)
            compose.onNodeWithTag("workflow_save").performClick()
            waitForTag("workflow_detail_title")
            compose.onNodeWithTag("workflow_detail_title").assertTextContains(renamed)

            back()
            query.assertTextContains("launch")
            scope.assertIsSelected()
            compose.onNodeWithText(renamed).assertIsDisplayed()
            compose.onNodeWithText(originalTitle).assertDoesNotExist()
        } finally {
            releaseCatalog.countDown()
        }
        compose.onNodeWithText(renamed).performClick()
        waitFor("Add to new chat draft")
        compose.onNodeWithText("Add to new chat draft").performClick()
        waitForTag("message_input")
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("/release-review Keep my existing draft")
        assertFalse(
            app.fixture.requests.any {
                it.method == "POST" &&
                    it.requestUrl?.encodedPath in setOf("/api/chat-threads", "/api/chat/events")
            }
        )
        back()
        query.assertTextContains("launch")
        scope.assertIsSelected()
        compose.onNodeWithText(renamed).assertIsDisplayed()
    }

    @Test
    fun returningFromWorkflowDetailsKeepsSearchResultsDuringCatalogRefresh() {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        val scope = compose.onNodeWithTag("search_type_Workflows")
        val query = compose.onNodeWithTag("chat_search_query")
        scope.performClick()
        query.performTextInput("launch")
        val originalTitle = app.fixture.releaseTitle
        waitFor(originalTitle)

        val catalogRequested = CountDownLatch(1)
        val releaseCatalog = CountDownLatch(1)
        app.fixture.beforeCatalog = {
            catalogRequested.countDown()
            releaseCatalog.await()
        }
        try {
            compose.onNodeWithText(originalTitle).performClick()
            waitFor("View workflow details")
            compose.onNodeWithText("View workflow details").performClick()
            waitForTag("workflow_detail_title")
            compose.waitUntil(5_000) { catalogRequested.count == 0L }

            back()
            query.assertTextContains("launch")
            scope.assertIsSelected()
            compose.onNodeWithText(originalTitle).assertIsDisplayed()

            val updatedTitle = "Launch planning"
            app.fixture.releaseTitle = updatedTitle
            releaseCatalog.countDown()
            waitFor(updatedTitle)
            compose.onNodeWithText(originalTitle).assertDoesNotExist()
        } finally {
            releaseCatalog.countDown()
        }
    }

    @Test
    fun workflowIntroRestoresResultsFocusWhileOtherSearchTypesAreLoading() {
        val messagesRequested = CountDownLatch(1)
        val releaseMessages = CountDownLatch(1)
        app.fixture.chats.searchMessages = {
            messagesRequested.countDown()
            releaseMessages.await()
            jsonResponse("""{"results":[]}""")
        }
        val releaseCatalog = CountDownLatch(1)
        try {
            app.gate.countDown()
            compose.onNodeWithContentDescription("Search workspace").performClick()
            val scope = compose.onNodeWithTag("search_type_All")
            val query = compose.onNodeWithTag("chat_search_query")
            query.performTextInput("checklist")
            val originalTitle = app.fixture.releaseTitle
            waitFor(originalTitle)
            compose.waitUntil(5_000) { messagesRequested.count == 0L }

            val catalogRequested = CountDownLatch(1)
            app.fixture.beforeCatalog = {
                catalogRequested.countDown()
                releaseCatalog.await()
            }
            compose.onNodeWithText(originalTitle).performClick()
            waitFor("View workflow details")
            compose.onNodeWithText("View workflow details").performClick()
            waitForTag("workflow_detail_title")
            compose.waitUntil(5_000) { catalogRequested.count == 0L }
            back()

            compose.onNodeWithText(originalTitle).performClick()
            waitFor("View workflow details")
            val updatedTitle = "Launch planning"
            app.fixture.releaseTitle = updatedTitle
            releaseCatalog.countDown()

            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("View workflow details").fetchSemanticsNodes().isEmpty()
            }
            compose.onNodeWithText(originalTitle).assertDoesNotExist()
            compose.onNodeWithTag("chat_search_results").assertIsFocused()
            scope.assertIsSelected()

            query.performTextReplacement("launch")
            waitFor(updatedTitle)
            compose.onNodeWithText("View workflow details").assertDoesNotExist()
        } finally {
            releaseCatalog.countDown()
            releaseMessages.countDown()
        }
    }

    @Test
    fun workspaceSearchKeepsItsReturnPathWhenTheWorkflowDraftBecomesAChat() {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        val scope = compose.onNodeWithTag("search_type_Workflows")
        val query = compose.onNodeWithTag("chat_search_query")
        scope.performClick()
        query.performTextInput("launch")
        waitFor(app.fixture.releaseTitle)
        compose.onNodeWithText(app.fixture.releaseTitle).performClick()
        waitFor("Add to new chat draft")
        compose.onNodeWithText("Add to new chat draft").performClick()
        waitForTag("message_input")
        compose.onNodeWithContentDescription("Send").performClick()

        waitFor("New conversation")
        back()
        query.assertTextContains("launch")
        scope.assertIsSelected()
        compose.onNodeWithText(app.fixture.releaseTitle).assertIsDisplayed()
    }

    @Test
    fun workspaceSearchReconnectsWithoutReopeningTheDismissedWorkflowIntro() {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("search_type_Workflows").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput("launch")
        waitFor(app.fixture.releaseTitle)
        compose.onNodeWithText(app.fixture.releaseTitle).performClick()
        waitFor("View workflow details")

        compose.runOnIdle { app.connectivity.value = false }
        waitFor("Go online to search this type")
        compose.onNodeWithText("View workflow details").assertDoesNotExist()
        compose.runOnIdle { app.connectivity.value = true }
        waitFor(app.fixture.releaseTitle)
        compose.onNodeWithText("View workflow details").assertDoesNotExist()
    }

    private fun waitFor(label: String) =
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(label).fetchSemanticsNodes().isNotEmpty()
        }

    private fun waitForTag(tag: String) =
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
        }

    private fun back() =
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
}
