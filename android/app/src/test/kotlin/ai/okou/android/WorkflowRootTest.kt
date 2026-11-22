package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerJournalStore
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
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

class WorkflowRootApplication : TestOkouApplication() {
    internal lateinit var fixture: WorkflowApiFixture
    val gate = CountDownLatch(1)

    override fun onCreate() {
        fixture = WorkflowApiFixture()
        fixture.beforeCatalog = { gate.await() }
        chatService = fixture.service
        composerService = fixture.service
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
        val jobs =
            compose.activity.let { activity ->
                compose.runOnIdle {
                    ViewModelProvider(activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready
                        ?.let {
                            listOfNotNull(
                                it.chats.viewModelScope.coroutineContext[Job],
                                it.composer.viewModelScope.coroutineContext[Job],
                                it.workflows?.viewModelScope?.coroutineContext?.get(Job),
                            )
                        }
                        .orEmpty()
                }
            }
        compose.activityRule.scenario.close()
        runBlocking { withTimeout(10_000) { jobs.forEach { it.join() } } }
        application.fixture.close()
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
        compose.onNodeWithText("Gmail · Needs connection").assertIsDisplayed()
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
    fun offlineDetailKeepsContentAndExplainsTheUnavailableActionInPlace() {
        openWorkflowDetail()
        val use = compose.onNodeWithTag("workflow_use").assertIsEnabled()

        app.connectivity.value = false
        val offline = "Offline · Showing last loaded data"
        waitFor(offline)
        compose.onNodeWithText("Workflow instructions").assertIsDisplayed()
        val notice = compose.onNodeWithText(offline).assertIsDisplayed().getUnclippedBoundsInRoot()
        val action = use.assertIsNotEnabled().getUnclippedBoundsInRoot()
        assertTrue(notice.bottom <= action.top)

        app.connectivity.value = true
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(offline).fetchSemanticsNodes().isEmpty()
        }
        use.assertIsEnabled()
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
    fun returningWithAConnectedAccountKeepsFocusOnTheSameRule() {
        val scenario = compose.activityRule.scenario
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            scenario.recreate()
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
        } finally {
            instrumentation.resetInTouchMode()
        }
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

    private fun openWorkflowDetail() {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Workflows").performClick()
        waitFor("Release checklist")
        compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE").performClick()
        waitForTag("workflow_detail_title")
    }

    private fun selectScope(label: String) =
        compose
            .onNode(
                hasText(label) and
                    SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)
            )
            .performClick()

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
