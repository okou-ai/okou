package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerJournalStore
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.util.UUID
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
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
        app.gate.countDown()
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
        app.fixture.close()
    }

    @Test
    fun workflowDirectoryScopesRulesAndReturnsFromDraftWithoutSending() {
        assertFalse(app.fixture.requests.any { it.requestUrl?.encodedPath == "/api/workflows" })
        compose.onNodeWithText("Workflows").performClick()
        compose.onNodeWithTag("workflow_query").assertIsDisplayed()
        app.gate.countDown()
        waitFor("Release checklist")
        assertTrue(
            compose
                .onNodeWithTag("workflow_row_$WORKFLOW_RELEASE")
                .getUnclippedBoundsInRoot()
                .height >= 80.dp
        )
        compose.onNodeWithText("Workspace shared").performClick()
        compose.onNodeWithText("Release checklist").assertDoesNotExist()
        compose.onNodeWithTag("workflow_row_$WORKFLOW_SHARED").performClick()
        waitForTag("workflow_detail_title")
        assertTrue(compose.onNodeWithTag("workflow_use").getUnclippedBoundsInRoot().height >= 48.dp)
        compose.onNodeWithText("Edit instructions").assertDoesNotExist()
        back()
        compose.onNodeWithText("All").performClick()
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
        waitFor("Confirm the release owner.")
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        waitFor("Paused · Needs connection")
        compose.onNodeWithTag("workflow_toggle_weekday").performClick()
        waitFor("Enabled")
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
