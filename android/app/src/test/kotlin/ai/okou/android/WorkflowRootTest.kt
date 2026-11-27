package ai.okou.android

import ai.okou.android.api.generated.WorkflowRunHistory
import ai.okou.android.api.generated.WorkflowRunHistoryEntryStatus
import ai.okou.android.api.generated.Workflows
import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerJournalStore
import android.app.TimePickerDialog
import android.os.Looper
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performFirstLinkClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToKey
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.platform.app.InstrumentationRegistry
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowSystemClock

class WorkflowRootApplication : TestOkouApplication() {
    internal lateinit var fixture: WorkflowApiFixture
    internal lateinit var connectorFixture: ConnectorApiFixture
    val gate = CountDownLatch(1)

    override fun onCreate() {
        fixture = WorkflowApiFixture(chats = ComposerApiFixture(simulateHistory = false).chats)
        fixture.beforeCatalog = { gate.await() }
        chatService = fixture.service
        composerService = fixture.service
        searchService = fixture.service
        workflows = fixture.service
        connectorFixture = ConnectorApiFixture()
        connectorService = connectorFixture.service
        journalStore =
            ComposerJournalStore(this, noBackupFilesDir.resolve("workflow-${UUID.randomUUID()}"))
        super.onCreate()
    }
}

internal abstract class WorkflowRootTestFixture {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    protected val app
        get() = compose.activity.application as WorkflowRootApplication

    @After
    fun tearDown() {
        val application = app
        application.gate.countDown()
        application.fixture.use {
            try {
                val jobs = compose.runOnIdle {
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
                                it.connectors?.viewModelScope?.coroutineContext?.get(Job),
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
                application.connectorFixture.use {
                    runBlocking { checkNotNull(application.journalStore).close() }
                }
            }
        }
    }

    protected fun openWorkflowDetail(id: String = WORKFLOW_RELEASE) {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Workflows").performClick()
        val row = "workflow_row_$id"
        waitForTag(row)
        compose.onNodeWithTag(row).performClick()
        waitForTag("workflow_detail_title")
    }

    protected fun withHardwareKeyboard(run: () -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            run()
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    protected fun SemanticsNodeInteraction.pressEnter() =
        performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused().performKeyInput {
            pressKey(Key.Enter)
        }

    protected fun selectScope(label: String) =
        compose
            .onNode(
                hasText(label) and
                    SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton),
            )
            .performClick()

    protected fun selectGmailTrigger() {
        compose.onNodeWithText("Event").performClick()
        compose.onNodeWithText("Google Calendar · Event created").performClick()
        compose.onNodeWithText("Gmail · Message received").performClick()
    }

    protected fun waitFor(label: String) =
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(label).fetchSemanticsNodes().isNotEmpty()
        }

    protected fun waitForTag(tag: String) =
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
        }

    protected fun SemanticsNodeInteraction.assertLabelLarge() {
        val layouts = mutableListOf<TextLayoutResult>()
        performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val style = layouts.single().layoutInput.style
        assertEquals(14.sp, style.fontSize)
        assertEquals(20.sp, style.lineHeight)
        assertEquals(FontWeight.Medium, style.fontWeight)
    }

    protected fun back() = compose.runOnIdle {
        compose.activity.onBackPressedDispatcher.onBackPressed()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w412dp-h840dp",
    application = WorkflowRootApplication::class,
)
internal class WorkflowRootTest : WorkflowRootTestFixture() {
    @Test
    fun blankWorkflowNameUsesTheCommandWithoutRenamingOnPurposeSave() {
        val blankTitle = "   "
        val command = "release-review"
        app.fixture.releaseTitle = blankTitle
        app.gate.countDown()
        compose.onNodeWithContentDescription("Workflows").performClick()
        val row = "workflow_row_$WORKFLOW_RELEASE"
        waitForTag(row)
        compose.onNodeWithTag("workflow_query").performTextInput("/$command")
        compose.onNodeWithText(command).assertIsDisplayed().performClick()
        waitForTag("workflow_detail_title")
        compose.onNodeWithTag("workflow_detail_title").assertTextContains(command)
        compose.onNodeWithTag("workflow_use").assertIsEnabled()

        compose.onNodeWithText("Edit instructions").performClick()
        compose.onNodeWithContentDescription("Display name").assertTextContains(command)
        val updatedPurpose = "Review the final launch assets."
        compose.onNodeWithContentDescription("Purpose").performTextReplacement(updatedPurpose)
        compose.onNodeWithTag("workflow_save").assertIsEnabled().performClick()

        waitForTag("workflow_detail_title")
        waitFor(updatedPurpose)
        compose.onNodeWithTag("workflow_detail_title").assertTextContains(command)
        compose.onNodeWithText(updatedPurpose).assertIsDisplayed()
        val patch =
            app.fixture.requests.single {
                it.method == "PATCH" &&
                    it.requestUrl?.encodedPath == "/api/workflows/$WORKFLOW_RELEASE"
            }
        val fields = Json.parseToJsonElement(patch.body.clone().readUtf8()).jsonObject
        assertEquals(setOf("description"), fields.keys)
        assertEquals(blankTitle, app.fixture.releaseTitle)
    }

    @Test
    fun compactWorkflowBackRestoresTheActivatedDirectoryRow() = withHardwareKeyboard {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Workflows").performClick()
        val tag = "workflow_row_$WORKFLOW_RELEASE"
        waitForTag(tag)
        val row = compose.onNodeWithTag(tag)
        row.pressEnter()
        waitForTag("workflow_detail_title")

        back()

        row.assertIsDisplayed().assertIsFocused()
    }

    @Test
    fun workflowBackRestoresTheScrolledRowAfterWindowRecreation() = withHardwareKeyboard {
        val service = app.fixture.chats
        val respond = service.commandResponse
        service.commandResponse = { request ->
            val response = respond(request)
            if (request.requestUrl?.encodedPath == "/api/workflows") {
                checkNotNull(response)
                val catalog =
                    Json.decodeFromString<Workflows>(checkNotNull(response.getBody()).readUtf8())
                val leadingRows =
                    List(16) { index ->
                        catalog
                            .first()
                            .copy(
                                id = UUID(0, index.toLong()).toString(),
                                name = "directory-item-$index",
                                displayName = "Directory item $index",
                            )
                    }
                response.setBody(Json.encodeToString(leadingRows + catalog))
            } else response
        }
        val originalQualifiers = RuntimeEnvironment.getQualifiers()
        try {
            app.gate.countDown()
            compose.onNodeWithContentDescription("Workflows").performClick()
            waitFor("Directory item 0")
            val row = compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE")
            row.assertDoesNotExist()
            compose.onNode(hasScrollToIndexAction()).performScrollToKey(WORKFLOW_RELEASE)
            row.pressEnter()
            waitForTag("workflow_detail_title")

            RuntimeEnvironment.setQualifiers("en-rUS-w520dp-h800dp")
            compose.activityRule.scenario.recreate()
            waitForTag("workflow_detail_title")
            compose.onNodeWithTag("workflow_directory").assertDoesNotExist()
            back()

            row.assertIsDisplayed().assertIsFocused()
        } finally {
            RuntimeEnvironment.setQualifiers(originalQualifiers)
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun wideWorkflowKeepsTheActivatedDirectoryRowFocused() = withHardwareKeyboard {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Workflows").performClick()
        val tag = "workflow_row_$WORKFLOW_RELEASE"
        waitForTag(tag)
        val row = compose.onNodeWithTag(tag)
        row.pressEnter()
        waitForTag("workflow_detail_title")

        row.assertIsDisplayed().assertIsSelected().assertIsFocused()
    }

    @Test
    fun terminalCatalogFailureReplacesTheSkeletonBelowTheFilters() {
        val fixture = app.fixture
        val gate = app.gate
        val response = fixture.chats.commandResponse
        fixture.chats.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/workflows") {
                gate.await()
                MockResponse().setResponseCode(400)
            } else response(request)
        }

        val loading = compose.onNodeWithTag("workflow_loading")
        compose.mainClock.autoAdvance = false
        try {
            compose.onNodeWithContentDescription("Workflows").performClick()
            compose.mainClock.advanceTimeByFrame()
            compose.onNodeWithTag("workflow_query").assertIsDisplayed()
            compose.mainClock.advanceTimeBy(200)
            loading.assertDoesNotExist()
            compose.mainClock.advanceTimeBy(80)
            loading.assertIsDisplayed()
        } finally {
            compose.mainClock.autoAdvance = true
        }
        gate.countDown()
        waitFor("Temporarily unable to load")
        val feedback =
            compose
                .onNodeWithText("Temporarily unable to load")
                .assertIsDisplayed()
                .assert(
                    SemanticsMatcher.expectValue(
                        SemanticsProperties.LiveRegion,
                        LiveRegionMode.Polite,
                    ),
                )
        compose.onNodeWithTag("workflow_loading").assertDoesNotExist()
        compose.onNodeWithTag("workflow_query").assertIsDisplayed()
        compose.onNodeWithTag("workflow_create").assertIsEnabled()
        val filter =
            compose
                .onNode(
                    hasText("All") and
                        SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton),
                )
                .getUnclippedBoundsInRoot()
        val bounds = feedback.getUnclippedBoundsInRoot()
        val viewport = compose.onNodeWithTag("workflow_read_failure").getUnclippedBoundsInRoot()
        val center = (viewport.left + viewport.right) / 2
        assertTrue((bounds.left + bounds.right) / 2 in (center - 1.dp)..(center + 1.dp))
        assertTrue(bounds.top > filter.bottom)
        val layouts = mutableListOf<TextLayoutResult>()
        feedback.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val style = layouts.single().layoutInput.style
        assertEquals(16.sp, style.fontSize)
        assertEquals(24.sp, style.lineHeight)
        selectScope("Workspace shared")
        feedback.assertIsDisplayed()
        back()
        compose.onNodeWithContentDescription("Workflows").assertIsDisplayed()
    }

    @Test
    fun cachedCatalogFailureOverlaysTheDirectoryWithoutMovingRowsOrReplaying() {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Workflows").performClick()
        waitForTag("workflow_row_$WORKFLOW_RELEASE")
        back()

        val fixture = app.fixture
        val gate = CountDownLatch(1)
        val response = fixture.chats.commandResponse
        fixture.chats.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/workflows") {
                gate.await()
                MockResponse().setResponseCode(400)
            } else response(request)
        }
        compose.onNodeWithContentDescription("Workflows").performClick()
        val row = compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE")
        val original =
            try {
                row.assertIsDisplayed().getUnclippedBoundsInRoot()
            } finally {
                gate.countDown()
            }
        val message = "Could not refresh the workflow directory. Showing loaded workflows."
        waitFor(message)
        val snackbar = compose.onNodeWithTag("workflow_read_snackbar").assertIsDisplayed()
        val feedbackBounds = snackbar.getUnclippedBoundsInRoot()
        val directory = compose.onNodeWithTag("workflow_directory").getUnclippedBoundsInRoot()
        assertEquals(original, row.getUnclippedBoundsInRoot())
        assertEquals(12.dp, feedbackBounds.left - directory.left)
        assertEquals(8.dp, directory.bottom - feedbackBounds.bottom)
        val text = compose.onNodeWithText(message).assertIsDisplayed()
        assertEquals(16.dp, text.getUnclippedBoundsInRoot().left - feedbackBounds.left)
        val layouts = mutableListOf<TextLayoutResult>()
        text.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertEquals(14.sp, layouts.single().layoutInput.style.fontSize)
        assertEquals(20.sp, layouts.single().layoutInput.style.lineHeight)
        val all = compose.onNodeWithTag("workflow_scope_All").getUnclippedBoundsInRoot()
        val onlyMe = compose.onNodeWithTag("workflow_scope_Private").getUnclippedBoundsInRoot()
        assertEquals(6.dp, onlyMe.left - all.right)
        assertTrue(all.bottom - all.top >= 48.dp)
        selectScope("Workspace shared")
        compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE").assertDoesNotExist()
        compose.onNodeWithTag("workflow_row_$WORKFLOW_SHARED").assertIsDisplayed()
        compose.onNodeWithText(message).assertDoesNotExist()
        selectScope("All")
        row.assertIsDisplayed()
        compose.onNodeWithText(message).assertDoesNotExist()

        back()
        val nextRead = CountDownLatch(1)
        fixture.chats.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/workflows") nextRead.await()
            response(request)
        }
        try {
            compose.onNodeWithContentDescription("Workflows").performClick()
            row.assertIsDisplayed()
            compose.onNodeWithText(message).assertDoesNotExist()
            compose.activityRule.scenario.recreate()
            row.assertIsDisplayed()
            compose.onNodeWithText(message).assertDoesNotExist()
        } finally {
            nextRead.countDown()
        }
    }

    @Test
    fun emptyDirectorySearchKeepsTheRecoveryAtTheStartOfTheResults() {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Workflows").performClick()
        val rowTag = "workflow_row_$WORKFLOW_RELEASE"
        waitForTag(rowTag)

        compose.onNodeWithTag("workflow_query").performTextReplacement("unmatched workflow")
        val title = compose.onNodeWithText("No matching workflows").assertIsDisplayed()
        val clear = compose.onNodeWithText("Clear search").assertIsEnabled()
        val all = compose.onNodeWithTag("workflow_scope_All").getUnclippedBoundsInRoot()
        val titleBounds = title.getUnclippedBoundsInRoot()
        val clearBounds = clear.getUnclippedBoundsInRoot()
        assertEquals(24.dp, titleBounds.top - all.bottom - 8.dp)
        assertEquals(12.dp, titleBounds.left - all.left)
        assertEquals(8.dp, clearBounds.top - titleBounds.bottom)
        assertTrue(clearBounds.bottom - clearBounds.top >= 48.dp)

        clear.performClick()
        compose.onNodeWithTag(rowTag).assertIsDisplayed()
    }

    @Test
    fun workflowDirectoryScopesRulesAndReturnsFromDraftWithoutSending() {
        assertFalse(app.fixture.requests.any { it.requestUrl?.encodedPath == "/api/workflows" })
        compose.onNodeWithContentDescription("Workflows").performClick()
        compose.onNodeWithTag("workflow_query").assertIsDisplayed()
        val newButton = compose.onNodeWithTag("workflow_create").getUnclippedBoundsInRoot()
        val newLabel = compose.onNodeWithText("New", useUnmergedTree = true)
        newLabel.assertLabelLarge()
        val newTextBounds = newLabel.getUnclippedBoundsInRoot()
        assertEquals(16.dp, newButton.right - newTextBounds.right)
        assertEquals(38.dp, newTextBounds.left - newButton.left)
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
        val purpose = compose.onNodeWithContentDescription("Purpose")
        val purposeTop = purpose.getUnclippedBoundsInRoot().top
        name.performTextReplacement(" ")
        compose.onNodeWithText("Enter a display name.").assertIsDisplayed()
        name.assert(
            SemanticsMatcher.expectValue(SemanticsProperties.Error, "Enter a display name."),
        )
        assertEquals(purposeTop, purpose.getUnclippedBoundsInRoot().top)
        compose.onNodeWithTag("workflow_save").assertIsNotEnabled()
        name.performTextReplacement("x".repeat(257))
        compose.onNodeWithText("Use 256 characters or fewer.").assertIsDisplayed()
        compose.onNodeWithTag("workflow_save").assertIsNotEnabled()
        name.performTextReplacement("Release checklist")
        compose.onNodeWithText("Use 256 characters or fewer.").assertDoesNotExist()
        assertEquals(purposeTop, purpose.getUnclippedBoundsInRoot().top)
        name.performTextInputSelection(TextRange.Zero)
        name.performSemanticsAction(SemanticsActions.SetText) { setText ->
            assertTrue(setText(AnnotatedString("Temporary name")))
            assertTrue(setText(AnnotatedString("Release checklist")))
        }
        name.assertTextContains("Release checklist")
        compose.onNodeWithTag("workflow_save").assertIsNotEnabled()
        val instructions =
            "Confirm the release owner.\n![Launch screenshot](<https://example.test/release.png>)"
        compose
            .onNodeWithText(
                "Review launch copy and product notes.\nCheck the website, email, and community assets.",
            )
            .performTextReplacement(instructions)
        compose.onNodeWithTag("workflow_save").performClick()
        waitForTag("workflow_detail_title")
        compose.onNodeWithText(instructions).assertIsDisplayed()
        assertEquals(instructions, app.fixture.instruction)
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
        selectGmailTrigger()
        compose.onNodeWithContentDescription("Subject contains").performTextInput("Release")
        compose
            .onNodeWithText("A Gmail connection is required to save this rule.")
            .assertIsDisplayed()
        compose.onNodeWithText("View connections").assertIsDisplayed()
        compose.onNodeWithTag("workflow_save").assertIsNotEnabled()
        back()
        compose
            .onNodeWithText(
                "Unsaved changes to “Release checklist” on this device will be discarded.",
            )
            .assertIsDisplayed()
        compose.onNodeWithText("Discard").performClick()
        compose.onNodeWithTag("workflow_toggle_weekday").performClick()
        waitFor("Enabled")
        compose.onNodeWithText(" · Shanghai (UTC+8)", substring = true).assertIsDisplayed()
        assertTrue(app.fixture.active.get())
        compose.onNodeWithTag("workflow_use").performTouchInput { click() }
        waitForTag("message_input")
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("/release-review Keep my existing draft")
        assertFalse(
            app.fixture.requests.any {
                it.method == "POST" &&
                    it.requestUrl?.encodedPath in setOf("/api/chat-threads", "/api/chat/events")
            },
        )
        back()
        compose.onNodeWithTag("workflow_tab_automations").assertIsSelected()
        compose.onNodeWithTag("workflow_use").assertIsNotFocused()
        compose.onNodeWithText("Enabled").assertIsDisplayed()
        back()
        compose.onNodeWithTag("workflow_query").assertTextContains("/release-review")
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun detailLoadingSharesTheContentInsetAndKeepsTheUseButtonInPlace() {
        val detail = CountDownLatch(1)
        app.fixture.beforeReleaseDetailRead = { detail.await() }
        val use = compose.onNodeWithTag("workflow_use")
        val (loadingBounds, pendingBounds, pendingTabs) =
            try {
                compose.onNodeWithContentDescription("Workflows").performClick()
                app.gate.countDown()
                waitFor("Release checklist")
                compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE").performClick()
                waitForTag("workflow_loading")
                val skeleton = compose.onNodeWithTag("workflow_loading").assertIsDisplayed()
                Triple(
                    skeleton.getUnclippedBoundsInRoot(),
                    use.assertIsDisplayed().assertIsNotEnabled().getUnclippedBoundsInRoot(),
                    compose.onNodeWithTag("workflow_loading_tabs").getUnclippedBoundsInRoot(),
                )
            } finally {
                detail.countDown()
            }

        waitForTag("workflow_detail_title")
        val title = compose.onNodeWithTag("workflow_detail_title").getUnclippedBoundsInRoot()
        assertEquals(title.left, loadingBounds.left)
        assertEquals(title.top, loadingBounds.top)
        assertEquals(pendingBounds, use.assertIsEnabled().getUnclippedBoundsInRoot())
        val tabs = compose.onNodeWithTag("workflow_tab_instructions").getUnclippedBoundsInRoot()
        assertEquals(tabs.top, pendingTabs.top)
        assertEquals(tabs.bottom, pendingTabs.bottom)
    }

    @Test
    fun returningFromWorkflowCreationRechecksTheFreshDirectory() = withHardwareKeyboard {
        compose.onNodeWithContentDescription("Workflows").performClick()
        app.gate.countDown()
        waitFor("Release checklist")
        selectScope("Workspace shared")
        val query = compose.onNodeWithTag("workflow_query")
        query.performTextInput("follow-up")

        fun catalogReads() =
            app.fixture.requests.count {
                it.method == "GET" && it.requestUrl?.encodedPath == "/api/workflows"
            }

        assertEquals(1, catalogReads())
        val create = compose.onNodeWithTag("workflow_create")
        create.pressEnter()
        waitForTag("message_input")
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("Help me create a private workflow.", substring = true)

        back()
        waitFor("Release follow-up")
        create.assertIsFocused()
        query.assertTextContains("follow-up")
        compose.onNodeWithText("Release checklist").assertDoesNotExist()
        compose.waitUntil(10_000) { catalogReads() == 2 }
    }

    @Test
    fun keyboardUseReturnsToTheSameDetailTabAndFooter() = withHardwareKeyboard {
        openWorkflowDetail()
        val history = compose.onNodeWithTag("workflow_tab_history")
        history.performClick()
        waitForTag("workflow_run_$WORKFLOW_SOURCE_RUN")
        val use = compose.onNodeWithTag("workflow_use")
        val before = use.getUnclippedBoundsInRoot()
        val instructions = compose.onNodeWithTag("workflow_tab_instructions")
        assertEquals(instructions.getUnclippedBoundsInRoot().left, before.left)
        assertEquals(history.getUnclippedBoundsInRoot().right, before.right)
        use.pressEnter()
        waitForTag("message_input")
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("/release-review Keep my existing draft")

        back()
        history.assertIsSelected()
        assertEquals(before, use.assertIsFocused().getUnclippedBoundsInRoot())
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun workflowCreationReturnsToTheDirectoryAfterTheWindowNarrows() = withHardwareKeyboard {
        val originalQualifiers = RuntimeEnvironment.getQualifiers()
        try {
            openWorkflowDetail()
            compose.onNodeWithTag("workflow_tab_automations").performClick()
            val create = compose.onNodeWithTag("workflow_create").assertIsDisplayed()
            create.pressEnter()
            waitForTag("message_input")

            RuntimeEnvironment.setQualifiers("en-rUS-w412dp-h892dp")
            compose.activityRule.scenario.recreate()
            waitForTag("message_input")
            back()

            compose.onNodeWithTag("workflow_directory").assertIsDisplayed()
            compose.onNodeWithTag("workflow_detail").assertDoesNotExist()
            create.assertIsFocused()
        } finally {
            RuntimeEnvironment.setQualifiers(originalQualifiers)
        }
    }

    @Test
    fun detailExplainsADraftReadFailureBesideUse() = withHardwareKeyboard {
        openWorkflowDetail()
        app.fixture.disconnectDraftRead = true
        val error = "Could not open the new chat draft. Your existing draft is preserved."
        compose.onNodeWithText("Workflow instructions").assertIsDisplayed()
        compose.onNodeWithText(error).assertDoesNotExist()
        val use = compose.onNodeWithTag("workflow_use").assertIsEnabled()
        use.pressEnter()
        waitFor(error)
        val notice = compose.onNodeWithText(error).assertIsDisplayed().getUnclippedBoundsInRoot()
        val action = use.assertIsEnabled().assertIsFocused().getUnclippedBoundsInRoot()
        assertTrue(notice.bottom <= action.top)
        assertTrue(
            app.fixture.requests.any {
                it.method == "GET" && it.requestUrl?.encodedPath == "/api/chat-drafts/composer"
            },
        )
        assertEquals("Keep my existing draft", app.fixture.previousDraft)

        app.fixture.disconnectDraftRead = false
        compose.onNodeWithTag("message_input").assertDoesNotExist()
        use.assertIsFocused().performKeyInput { pressKey(Key.Enter) }
        waitForTag("message_input")
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("/release-review Keep my existing draft")
    }

    @Test
    fun failedDraftReadKeepsFocusOnTheTabTheUserMovedTo() = withHardwareKeyboard {
        app.gate.countDown()
        waitFor("Personal chat")
        openWorkflowDetail()
        app.fixture.disconnectDraftRead = true
        val requested = CountDownLatch(1)
        val releaseDraft = CountDownLatch(1)
        app.fixture.beforeDraftRead = {
            requested.countDown()
            releaseDraft.await()
        }
        val use = compose.onNodeWithTag("workflow_use")
        val history = compose.onNodeWithTag("workflow_tab_history")
        val bounds = use.getUnclippedBoundsInRoot()
        try {
            use.pressEnter()
            compose.waitUntil(10_000) { compose.runOnIdle { requested.count == 0L } }
            assertEquals(
                bounds,
                use.assertIsNotEnabled().assertIsFocused().getUnclippedBoundsInRoot(),
            )
            history.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        } finally {
            releaseDraft.countDown()
        }
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Could not open the new chat draft", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        use.assertIsEnabled()
        history.assertIsFocused()
    }

    @Test
    fun saveReadsTheCurrentNativeInputBeforeTheNextFrame() {
        openWorkflowDetail()
        compose.onNodeWithText("Edit instructions").performClick()
        val instruction = compose.onNodeWithContentDescription("Workflow instructions")
        instruction.performTextReplacement("Check the launch owner.")
        val replace =
            checkNotNull(instruction.fetchSemanticsNode().config[SemanticsActions.SetText].action)
        val save = compose.onNodeWithTag("workflow_save").assertIsEnabled()
        val submit = checkNotNull(save.fetchSemanticsNode().config[SemanticsActions.OnClick].action)
        val latest = "Check the launch owner and date."
        compose.runOnIdle {
            assertTrue(replace(AnnotatedString(latest)))
            assertTrue(submit())
        }

        waitForTag("workflow_detail_title")
        assertEquals(latest, app.fixture.instruction)
    }

    @Test
    fun editorRetainsInputAndFocusAfterTransportFailure() = withHardwareKeyboard {
        openWorkflowDetail()
        app.fixture.disconnectInstructionSave = true
        val original = app.fixture.instruction
        compose.onNodeWithText("Edit instructions").assertIsEnabled().performClick()
        val instruction = compose.onNodeWithContentDescription("Workflow instructions")
        instruction.performTextReplacement("Check the launch owner.")
        instruction.performTextInputSelection(TextRange(4, 8))

        val error = "Could not save your changes."
        val save = compose.onNodeWithTag("workflow_save").assertIsEnabled()
        val saveBounds = save.getUnclippedBoundsInRoot()
        val fields = compose.onNodeWithTag("workflow_editor_fields")
        val fieldsBounds = fields.getUnclippedBoundsInRoot()
        val cancel = compose.onNodeWithText("Cancel")
        val cancelBounds = cancel.getUnclippedBoundsInRoot()
        for (label in listOf("Save", "Cancel")) {
            compose.onNodeWithText(label, useUnmergedTree = true).assertLabelLarge()
        }
        save.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        val selection =
            instruction.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange]
        compose.onNodeWithText(error).assertDoesNotExist()
        val releaseSave = CountDownLatch(1)
        app.fixture.beforeInstructionSave = { releaseSave.await() }
        try {
            save.performClick()
            save
                .assertIsNotEnabled()
                .assertContentDescriptionEquals("Save")
                .assert(
                    SemanticsMatcher.expectValue(
                        SemanticsProperties.StateDescription,
                        "Saving…",
                    ),
                )
                .assert(
                    SemanticsMatcher.expectValue(
                        SemanticsProperties.LiveRegion,
                        LiveRegionMode.Polite,
                    ),
                )
            assertEquals(saveBounds, save.getUnclippedBoundsInRoot())
            assertEquals(cancelBounds, cancel.assertIsNotEnabled().getUnclippedBoundsInRoot())
            compose.onNodeWithContentDescription("Back").assertIsNotEnabled()
            assertEquals(fieldsBounds, fields.getUnclippedBoundsInRoot())
        } finally {
            releaseSave.countDown()
        }
        waitFor(error)
        instruction.assertTextContains("Check the launch owner.")
        assertEquals(
            selection,
            instruction.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        val notice = compose.onNodeWithText(error).getUnclippedBoundsInRoot()
        assertEquals(
            8.dp,
            save.assertIsEnabled().assertIsFocused().getUnclippedBoundsInRoot().top - notice.bottom,
        )
        assertEquals(saveBounds, save.getUnclippedBoundsInRoot())
        assertEquals(cancelBounds, cancel.getUnclippedBoundsInRoot())
        assertEquals(fieldsBounds, fields.getUnclippedBoundsInRoot())
        val saves =
            app.fixture.requests.filter {
                it.method == "PATCH" &&
                    it.requestUrl?.encodedPath == "/api/workflows/$WORKFLOW_RELEASE"
            }
        assertEquals(1, saves.size)

        app.fixture.disconnectInstructionSave = false
        assertEquals(original, app.fixture.instruction)
        save.performClick()
        waitForTag("workflow_detail_title")
        compose.onNodeWithText("Check the launch owner.").assertIsDisplayed()
    }

    @Test
    fun instructionConflictShowsTheServerOutcomeAndPreservesTheEdit() {
        openWorkflowDetail()
        val model = compose.runOnIdle {
            val session = ViewModelProvider(compose.activity)[SessionModel::class.java]
            checkNotNull(session.uiState.value.ready?.workflows)
        }
        val fixture = app.fixture
        val latest = "Review the release checklist in the web app."
        fixture.beforeInstructionSave = { fixture.instruction = latest }
        fixture.instructionSaveConflict = true
        compose.onNodeWithText("Edit instructions").performClick()
        val instruction = compose.onNodeWithContentDescription("Workflow instructions")
        instruction.performTextReplacement("Check the launch owner.")
        val save = compose.onNodeWithTag("workflow_save")
        save.performClick()

        val error = "This workflow changed while saving. Your edits are preserved."
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.state.value.detail?.instruction == latest }
        }
        instruction.assertTextContains("Check the launch owner.")
        assertTrue(
            compose.onNodeWithText(error).assertIsDisplayed().getUnclippedBoundsInRoot().bottom <=
                save.assertIsEnabled().getUnclippedBoundsInRoot().top,
        )

        instruction.performTextReplacement("Check the launch owner and date.")
        compose.onNodeWithText(error).assertDoesNotExist()
    }

    @Test
    fun keyboardArrowsSelectAndFocusTheAdjacentDetailTabs() = withHardwareKeyboard {
        openWorkflowDetail()
        val instructions = compose.onNodeWithTag("workflow_tab_instructions")
        val automations = compose.onNodeWithTag("workflow_tab_automations")
        val history = compose.onNodeWithTag("workflow_tab_history")

        for (label in listOf("Instructions", "Automations", "Run history", "Use in chat")) {
            compose.onNodeWithText(label, useUnmergedTree = true).assertLabelLarge()
        }
        instructions.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        instructions.performKeyInput { pressKey(Key.DirectionRight) }
        automations.assertIsSelected().assertIsFocused()
        automations.performKeyInput { pressKey(Key.MoveEnd) }
        history.assertIsSelected().assertIsFocused()
        history.performKeyInput { pressKey(Key.DirectionRight) }
        instructions.assertIsSelected().assertIsFocused()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w412dp-h840dp",
    application = WorkflowRootApplication::class,
)
internal class WorkflowRuleRootTest : WorkflowRootTestFixture() {
    @Test
    fun closingInstructionsEditorReturnsKeyboardFocusToItsAction() = withHardwareKeyboard {
        openWorkflowDetail()
        val edit = compose.onNodeWithText("Edit instructions")
        edit.pressEnter()
        compose.onNodeWithText("Cancel").pressEnter()
        edit.assertIsFocused().performKeyInput { pressKey(Key.Enter) }
        val field = compose.onNodeWithContentDescription("Workflow instructions")
        val draft = "Prepare the release.\n![Checklist](<https://example.test/checklist.png>)"
        field.performTextReplacement(draft)
        compose.onNodeWithText("Cancel").pressEnter()
        compose
            .onNodeWithText(
                "Unsaved changes to “Release checklist” on this device will be discarded.",
            )
            .assertIsDisplayed()
        compose.onNodeWithText("Keep editing").pressEnter()
        field.assertTextContains(draft)
        compose.onNodeWithText("Cancel").pressEnter()
        compose.onNodeWithText("Discard").pressEnter()
        edit.assertIsFocused()
        compose.onNodeWithTag("workflow_detail_title").assertTextContains(app.fixture.releaseTitle)
    }

    @Test
    fun frequencyMenuMarksItsValueAndReturnsKeyboardFocus() = withHardwareKeyboard {
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        compose.onNodeWithText("Add automation").pressEnter()

        val weekdays = compose.onNodeWithText("Weekdays")
        val inMenu = hasAnyAncestor(hasTestTag("workspace_popup"))
        val selected = compose.onNode(hasText("Weekdays") and inMenu)
        val daily = compose.onNode(hasText("Daily") and inMenu)

        weekdays.pressEnter()
        compose.onNode(hasText("Weekdays") and inMenu, useUnmergedTree = true).assertLabelLarge()
        val popup = compose.onNodeWithTag("workspace_popup").getUnclippedBoundsInRoot()
        val row = selected.getUnclippedBoundsInRoot()
        assertEquals(244.dp, popup.right - popup.left)
        assertEquals(popup.right - popup.left, row.right - row.left)
        assertTrue(row.bottom - row.top >= 48.dp)
        selected.assertIsSelected().assertIsFocused().performKeyInput { pressKey(Key.Tab) }
        weekdays.assertIsFocused().performKeyInput { pressKey(Key.Enter) }
        selected.assertIsSelected().assertIsFocused().performKeyInput { pressKey(Key.Escape) }
        weekdays.assertIsFocused().performKeyInput { pressKey(Key.Enter) }
        selected.assertIsFocused().performKeyInput { pressKey(Key.DirectionDown) }
        daily.assertIsFocused().performKeyInput { pressKey(Key.Enter) }
        compose.onNodeWithText("Daily").assertIsFocused()
    }

    @Test
    fun newScheduleUsesTheLocalTimezoneBeforePreferencesSync() {
        openWorkflowDetail()
        val pendingWrite = CompletableDeferred<Unit>()
        app.preferenceWrite = { _, save ->
            pendingWrite.await()
            save()
        }
        try {
            compose.runOnIdle {
                val session = ViewModelProvider(compose.activity)[SessionModel::class.java]
                val preferences = checkNotNull(session.uiState.value.ready).preferences
                preferences.selectTimezone("Asia/Tokyo")
                assertEquals("UTC", preferences.uiState.value.confirmed.timezone)
            }
            compose.onNodeWithTag("workflow_tab_automations").performClick()
            compose.onNodeWithText("Add automation").assertIsEnabled().performClick()

            compose.onNodeWithText("Tokyo (UTC+9)").assertIsDisplayed()
        } finally {
            pendingWrite.complete(Unit)
        }
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
            val selection = TextRange(2, 8)
            input
                .performSemanticsAction(SemanticsActions.RequestFocus)
                .assertIsFocused()
                .performTextInputSelection(selection)
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
            compose
                .onNodeWithText(
                    "Unsaved changes to “Release checklist” on this device will be discarded.",
                )
                .assertIsDisplayed()
            compose
                .onNodeWithText("Keep editing")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()
            input
                .assertIsFocused()
                .assertTextContains("Prepare the release")
                .assert(
                    SemanticsMatcher.expectValue(
                        SemanticsProperties.TextSelectionRange,
                        selection,
                    ),
                )

            compose.onNodeWithText("Cancel").performScrollTo().assertIsDisplayed().performClick()
            compose.onNodeWithText("Discard").performScrollTo().assertIsDisplayed().performClick()
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
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun wideEditorKeepsTheDirectoryVisibleAndRestoresItsInputOnReturn() = withHardwareKeyboard {
        openWorkflowDetail()
        val query = compose.onNodeWithTag("workflow_query")
        query.performTextReplacement("Release")
        selectScope("Only me")
        val row = compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE")
        val originalRow = row.assertIsEnabled().getUnclippedBoundsInRoot()
        val scope = compose.onNodeWithTag("workflow_scope_Private").assertIsSelected()
        val filterScroll =
            compose.onNode(
                hasAnyDescendant(hasTestTag("workflow_scope_Private")) and
                    SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollBy),
            )
        filterScroll.assertExists()
        val clear = compose.onNodeWithContentDescription("Clear search")
        val back =
            compose.onNode(
                hasContentDescription("Back") and hasAnyAncestor(hasTestTag("workflow_directory")),
            )
        val edit = compose.onNodeWithText("Edit instructions")
        edit.pressEnter()

        query.assertIsNotEnabled().assertTextContains("Release")
        clear.assertIsNotEnabled()
        scope.assertIsNotEnabled().assertIsSelected()
        filterScroll.assertDoesNotExist()
        back.assertIsNotEnabled()
        assertEquals(originalRow, row.assertIsNotEnabled().getUnclippedBoundsInRoot())

        compose.onNodeWithText("Cancel").pressEnter()
        edit.assertIsFocused()
        query.assertIsEnabled().assertTextContains("Release")
        clear.assertIsEnabled()
        scope.assertIsEnabled().assertIsSelected()
        filterScroll.assertExists()
        back.assertIsEnabled()
        assertEquals(originalRow, row.assertIsEnabled().getUnclippedBoundsInRoot())
    }

    @Test
    @Config(qualifiers = "de-rDE-w900dp-h820dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun wideEditorPreservesTheScrolledFilterStripAtLargeText() {
        val originalScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            compose.activityRule.scenario.onActivity {
                assertEquals(2f, it.resources.configuration.fontScale, 0f)
            }
            openWorkflowDetail()
            selectScope("Nur ich")
            val scope = compose.onNodeWithTag("workflow_scope_Private").assertIsSelected()
            val initialBounds = scope.getUnclippedBoundsInRoot()
            val filter =
                compose.onNode(
                    hasAnyDescendant(hasTestTag("workflow_scope_Private")) and
                        SemanticsMatcher.keyIsDefined(
                            SemanticsProperties.HorizontalScrollAxisRange,
                        ),
                )
            val range =
                filter.fetchSemanticsNode().config[SemanticsProperties.HorizontalScrollAxisRange]
            val extent = range.maxValue()
            assertTrue(extent > 0f)
            filter.performSemanticsAction(SemanticsActions.ScrollBy) { it(extent, 0f) }
            val scrolledBounds = scope.getUnclippedBoundsInRoot()
            assertTrue(scrolledBounds.left < initialBounds.left)

            compose.onNodeWithText("Anweisungen bearbeiten").performClick()
            assertEquals(scrolledBounds, scope.assertIsNotEnabled().getUnclippedBoundsInRoot())
            compose.onNodeWithText("Abbrechen").performClick()
            assertEquals(scrolledBounds, scope.assertIsEnabled().getUnclippedBoundsInRoot())
        } finally {
            RuntimeEnvironment.setFontScale(originalScale)
        }
    }

    @Test
    @Config(qualifiers = "de-rDE-w360dp-h840dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun automationHeadingAndActionStayReadableInANarrowWindowAtLargeText() {
        val originalScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            compose.activityRule.scenario.onActivity {
                assertEquals(360, it.resources.configuration.screenWidthDp)
                assertEquals(2f, it.resources.configuration.fontScale, 0f)
            }
            openWorkflowDetail()
            compose.onNodeWithTag("workflow_tab_automations").performClick()
            val title = compose.onNodeWithText("Auslöseregeln", useUnmergedTree = true)
            val add = compose.onNodeWithText("Automatisierung hinzufügen")
            val layouts = mutableListOf<TextLayoutResult>()
            title.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            val layout = layouts.single()
            assertEquals(
                "Heading ${layout.size} and action ${add.getUnclippedBoundsInRoot()}",
                1,
                layout.lineCount,
            )
            title.assertIsDisplayed()
            add.assertIsDisplayed().assertIsEnabled().performClick()
            compose.onNodeWithTag("workflow_save").assertIsDisplayed()
        } finally {
            RuntimeEnvironment.setFontScale(originalScale)
        }
    }

    @Test
    fun pendingRuleKeepsTheConfirmedStatusAndFocusedActionUntilTheReceipt() = withHardwareKeyboard {
        val fixture = app.fixture
        fixture.active.set(true)
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        val rule = hasAnyAncestor(hasTestTag("workflow_rule_weekday"))
        val enabled = compose.onNode(hasText("Enabled") and rule)
        val toggle = compose.onNodeWithTag("workflow_toggle_weekday")
        val bounds = toggle.assertIsEnabled().getUnclippedBoundsInRoot()
        val requested = CountDownLatch(1)
        val release = CountDownLatch(1)
        fixture.beforeWeekdayToggle = {
            requested.countDown()
            release.await()
        }
        try {
            toggle.pressEnter()
            compose.waitUntil(10_000) { compose.runOnIdle { requested.count == 0L } }
            enabled.assertIsDisplayed()
            assertEquals(
                bounds,
                toggle
                    .assertIsNotEnabled()
                    .assertIsFocused()
                    .assertContentDescriptionEquals("Pause")
                    .assert(
                        SemanticsMatcher.expectValue(
                            SemanticsProperties.StateDescription,
                            "Saving…",
                        ),
                    )
                    .getUnclippedBoundsInRoot(),
            )
            toggle.performKeyInput { pressKey(Key.Enter) }
        } finally {
            release.countDown()
        }

        val paused = hasText("Paused") and rule
        compose.waitUntil(10_000) { compose.onAllNodes(paused).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(paused).assertIsDisplayed()
        toggle.assertIsEnabled().assertIsFocused().assertTextContains("Enable")
        assertEquals(
            1,
            fixture.requests.count {
                it.requestUrl?.encodedPath == "/api/workflow-automations/weekday/disable"
            },
        )
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
    fun memberCanCreateEditEnableAndPauseTheirRuleOnASharedWorkflow() = withHardwareKeyboard {
        val fixture = app.fixture
        val releaseCreate = CountDownLatch(1)
        fixture.beforeSharedScheduleCreate = { releaseCreate.await() }
        openWorkflowDetail(WORKFLOW_SHARED)
        compose.onNodeWithText("Edit instructions").assertDoesNotExist()
        val useBounds = compose.onNodeWithTag("workflow_use").getUnclippedBoundsInRoot()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        compose.onNodeWithText("No automations yet").assertIsDisplayed()
        val add = compose.onNodeWithText("Add automation").assertIsEnabled()
        val addBounds = add.getUnclippedBoundsInRoot()
        assertTrue(addBounds.bottom - addBounds.top >= 48.dp)
        val addLabel = compose.onNodeWithText("Add automation", useUnmergedTree = true)
        addLabel.assertLabelLarge()
        val addTextBounds = addLabel.getUnclippedBoundsInRoot()
        assertEquals(24.dp, addTextBounds.left - addBounds.left)
        assertEquals(24.dp, addBounds.right - addTextBounds.right)
        add.pressEnter()

        val save = compose.onNodeWithTag("workflow_save").assertIsEnabled()
        val saveBounds = save.getUnclippedBoundsInRoot()
        assertTrue(saveBounds.bottom - saveBounds.top >= 48.dp)
        assertEquals(useBounds.right, saveBounds.right)
        val time = compose.onNodeWithContentDescription("Time")
        val timeBounds = time.getUnclippedBoundsInRoot()
        assertTrue(timeBounds.bottom - timeBounds.top >= 56.dp)
        pickWorkflowTime(time, 9, 30)
        val timezone = compose.onNodeWithTag("workflow_timezone")
        timezone.pressEnter()
        compose
            .onNode(hasText("Coordinated Universal Time (UTC+0)") and isSelectable())
            .assertIsSelected()
            .assertIsFocused()
        val kathmandu = android.icu.util.TimeZone.getCanonicalID("Asia/Kathmandu")
        compose
            .onNode(hasScrollToIndexAction() and hasAnyAncestor(isDialog()))
            .performScrollToKey(kathmandu)
        compose.onNode(hasText("Kathmandu (UTC+5:45)") and isSelectable()).pressEnter()
        timezone.assertIsFocused().assertTextContains("Kathmandu (UTC+5:45)")
        val createPath = "/api/workflows/$WORKFLOW_SHARED/automations"
        try {
            save.pressEnter()
            compose.waitUntil(10_000) {
                fixture.requests.any {
                    it.method == "POST" && it.requestUrl?.encodedPath == createPath
                }
            }
            save.assertIsNotEnabled()
            time.assertTextContains("09:30")
        } finally {
            releaseCreate.countDown()
        }

        waitFor("Weekdays at 09:30")
        waitFor("Paused")
        assertEquals(addBounds, add.assertIsFocused().getUnclippedBoundsInRoot())
        val create =
            fixture.requests.single {
                it.method == "POST" && it.requestUrl?.encodedPath == createPath
            }
        val body = Json.parseToJsonElement(create.body.clone().readUtf8()).jsonObject
        assertFalse(body.getValue("enabled").jsonPrimitive.boolean)
        val schedule = body.getValue("schedule").jsonObject
        assertEquals("30 9 * * 1-5", schedule.getValue("cronExpression").jsonPrimitive.content)
        assertEquals(kathmandu, schedule.getValue("timezone").jsonPrimitive.content)

        val edit =
            compose.onNode(
                hasText("Edit") and hasAnyAncestor(hasTestTag("workflow_rule_shared-weekday")),
            )
        edit.pressEnter()
        pickWorkflowTime(time, 10, 0)
        save.assertIsEnabled().pressEnter()
        waitFor("Weekdays at 10:00")
        edit.assertIsFocused()
        val toggle = compose.onNodeWithTag("workflow_toggle_shared-weekday")
        toggle.assertIsEnabled().pressEnter()
        waitFor("Enabled")
        toggle.assertIsFocused().assertIsEnabled().performKeyInput { pressKey(Key.Enter) }
        waitFor("Paused")
        toggle.assertIsFocused()
        compose.onNodeWithText("Weekdays at 10:00").assertIsDisplayed()
    }

    private fun pickWorkflowTime(field: SemanticsNodeInteraction, hour: Int, minute: Int) {
        field.pressEnter()
        compose.runOnIdle {
            val dialog = ShadowDialog.getLatestDialog() as TimePickerDialog
            assertTrue(dialog.isShowing)
            dialog.updateTime(hour, minute)
            dialog.getButton(TimePickerDialog.BUTTON_POSITIVE).performClick()
        }
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
    fun returningWithAConnectedAccountKeepsFocusOnTheSameRule() = withHardwareKeyboard {
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

        waitFor("Gmail")
        waitFor("Connect account")
        compose.onNodeWithContentDescription("Back").performClick()
        waitFor("Enabled · Needs connection")
        compose.onNodeWithText("View connections").assertIsFocused().performClick()
        waitFor("Connect account")

        app.connectorFixture.authorizeGmail()
        app.fixture.gmailConnected.set(true)
        compose.onNodeWithContentDescription("Back").performClick()

        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("View connections").fetchSemanticsNodes().isEmpty()
        }
        compose.onNodeWithTag("workflow_tab_automations").assertIsSelected()
        compose.onNodeWithTag("workflow_toggle_gmail").assertIsFocused()
    }

    @Test
    fun connectingAnAccountPreservesTheSharedRuleEditorAndEnablesSave() = withHardwareKeyboard {
        val releaseConnections = CountDownLatch(1)
        app.fixture.beforeConnectionsRead = { releaseConnections.await() }
        val add = compose.onNodeWithText("Add automation")
        val save = compose.onNodeWithTag("workflow_save")
        val connection = compose.onNodeWithText("View connections")
        val subject = compose.onNodeWithContentDescription("Subject contains")

        try {
            openWorkflowDetail(WORKFLOW_SHARED)
            compose.onNodeWithTag("workflow_tab_automations").performClick()
            add.pressEnter()
            compose.onNodeWithText(app.fixture.sharedTitle).assertIsDisplayed()
            selectGmailTrigger()
            subject.performTextInput("Release summary")
            compose.onNodeWithText("Schedule").performClick().assertIsSelected()
            compose.onNodeWithText("Event").performClick().assertIsSelected()
            compose.onNodeWithText("Gmail · Message received").assertIsDisplayed()
            subject.assertTextContains("Release summary")
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
            cancelBounds.right < connectionBounds.left && connectionBounds.right < saveBounds.left,
        )
        connection
            .performSemanticsAction(SemanticsActions.RequestFocus)
            .assertIsFocused()
            .performClick()

        waitFor("Connect account")
        app.connectorFixture.authorizeGmail()
        app.fixture.gmailConnected.set(true)
        compose.onNodeWithContentDescription("Back").performClick()

        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("View connections").fetchSemanticsNodes().isEmpty()
        }
        subject.assertTextContains("Release summary")
        save.assertIsEnabled().assertIsFocused()
        compose.onNodeWithText("Cancel").pressEnter()
        compose.onNodeWithText("Discard").pressEnter()
        add.assertIsFocused()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun calendarEditorOpensCalendarInTheWideConnectorPaneAndReturnsToItsDraft() {
        app.connectorFixture.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
        app.connectorFixture.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        compose.onNodeWithText("Add automation").performClick()
        compose.onNodeWithText("Event").performClick().assertIsSelected()
        compose.onNodeWithText("Google Calendar · Event created").assertIsDisplayed()
        val calendar = compose.onNodeWithContentDescription("Calendar ID")
        calendar.performTextReplacement("test-calendar")
        waitFor("View connections")
        compose.onNodeWithText("View connections").performClick()

        waitFor("Connect account")
        compose.onNodeWithTag("connector-google-calendar").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back").performClick()

        waitFor("View connections")
        calendar.assertTextContains("test-calendar")
        compose.onNodeWithTag("workflow_save").assertIsNotEnabled()
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun shortAutomationEditorKeepsTheDraftAndConnectionActionReachable() {
        val originalQualifiers = RuntimeEnvironment.getQualifiers()
        val originalScale = RuntimeEnvironment.getFontScale()
        try {
            openWorkflowDetail(WORKFLOW_SHARED)
            compose.onNodeWithTag("workflow_tab_automations").performClick()
            compose.onNodeWithText("Add automation").performClick()
            selectGmailTrigger()
            val subject = compose.onNodeWithContentDescription("Subject contains")
            subject.performScrollTo().performTextReplacement("Release summary")
            waitFor("View connections")

            RuntimeEnvironment.setQualifiers("en-rUS-w360dp-h230dp")
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            waitForTag("workflow_editor_fields")
            val fields = compose.onNodeWithTag("workflow_editor_fields").getUnclippedBoundsInRoot()
            assertTrue(
                "Editor viewport: ${fields.bottom - fields.top}",
                fields.bottom - fields.top >= 48.dp,
            )
            subject.performScrollTo().assertIsDisplayed().assertTextContains("Release summary")
            compose.onNodeWithText("View connections").performScrollTo().assertIsEnabled()
            compose.onNodeWithTag("workflow_save").performScrollTo().assertIsNotEnabled()
        } finally {
            RuntimeEnvironment.setQualifiers(originalQualifiers)
            RuntimeEnvironment.setFontScale(originalScale)
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w412dp-h840dp",
    application = WorkflowRootApplication::class,
)
internal class WorkflowHistoryRootTest : WorkflowRootTestFixture() {
    @Test
    fun returningToExpiredHistoryDoesNotRestartTheSkeletonDelayWhenDetailArrives() {
        openWorkflowDetail()
        val historyTab = compose.onNodeWithTag("workflow_tab_history")
        historyTab.performClick()
        val runTag = "workflow_run_$WORKFLOW_SOURCE_RUN"
        val source = hasTestTag(runTag) and hasClickAction()
        compose.waitUntil(10_000) { compose.onAllNodes(source).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(source).performClick()
        waitForTag("conversation")

        val detailRequested = CountDownLatch(1)
        val historyRequested = CountDownLatch(1)
        val releaseDetail = CountDownLatch(1)
        val releaseHistory = CountDownLatch(1)
        app.fixture.beforeReleaseDetailRead = {
            detailRequested.countDown()
            releaseDetail.await()
        }
        app.fixture.beforeHistoryRead = {
            historyRequested.countDown()
            releaseHistory.await()
        }
        compose.mainClock.autoAdvance = false
        try {
            compose.runOnIdle { ShadowSystemClock.advanceBy(Duration.ofMinutes(10)) }
            back()
            compose.mainClock.advanceTimeByFrame()
            compose.waitUntil(10_000) {
                detailRequested.count == 0L && historyRequested.count == 0L
            }
            compose.mainClock.advanceTimeBy(288)
            compose.onNodeWithTag("workflow_loading").assertIsDisplayed()

            releaseDetail.countDown()
            val tabs = compose.onAllNodesWithTag("workflow_tab_history")
            compose.waitUntil(10_000) {
                compose.mainClock.advanceTimeByFrame()
                tabs.fetchSemanticsNodes().isNotEmpty()
            }
            historyTab.assertIsSelected()
            compose.onNodeWithTag("workflow_history_loading").assertIsDisplayed()
        } finally {
            releaseDetail.countDown()
            releaseHistory.countDown()
            compose.mainClock.autoAdvance = true
        }
        waitForTag(runTag)
        compose.onNodeWithTag(runTag).assertTextContains("Running", substring = true)
        compose.onNodeWithTag("workflow_history_loading").assertDoesNotExist()
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun historyLoadingWaitsForTheSharedDelayAndReservesScaledRows() {
        val originalScale = app.resources.configuration.fontScale
        val release = CountDownLatch(1)
        app.fixture.beforeHistoryRead = { release.await() }
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            openWorkflowDetail()
            val use = compose.onNodeWithTag("workflow_use")
            val useBounds = use.assertIsEnabled().getUnclippedBoundsInRoot()
            val loading = compose.onNodeWithTag("workflow_history_loading")
            compose.mainClock.autoAdvance = false
            val rowBounds =
                try {
                    compose.onNodeWithTag("workflow_tab_history").performClick()
                    compose.mainClock.advanceTimeByFrame()
                    compose.mainClock.advanceTimeBy(200)
                    loading.assertDoesNotExist()
                    compose.mainClock.advanceTimeBy(80)
                    loading.assertIsDisplayed()
                    compose
                        .onAllNodesWithTag("workflow_history_loading_row")[0]
                        .getUnclippedBoundsInRoot()
                } finally {
                    compose.mainClock.autoAdvance = true
                    release.countDown()
                }
            assertTrue(rowBounds.bottom - rowBounds.top > 64.dp)
            val tag = "workflow_run_$WORKFLOW_SOURCE_RUN"
            waitForTag(tag)
            loading.assertDoesNotExist()
            val loaded = compose.onNodeWithTag(tag).assertTextContains("Running", substring = true)
            val loadedBounds = loaded.getUnclippedBoundsInRoot()
            assertEquals(rowBounds.top, loadedBounds.top)
            assertEquals(rowBounds.left, loadedBounds.left)
            assertEquals(rowBounds.right, loadedBounds.right)
            assertEquals(useBounds, use.assertIsEnabled().getUnclippedBoundsInRoot())
        } finally {
            release.countDown()
            RuntimeEnvironment.setFontScale(originalScale)
        }
    }

    @Test
    fun firstHistoryFailureUsesTheBodyBetweenTheHeadingAndUseAction() {
        val fixture = app.fixture
        val respond = fixture.chats.commandResponse
        fixture.chats.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/workflows/$WORKFLOW_RELEASE/run-history") {
                MockResponse().setResponseCode(400)
            } else respond(request)
        }
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_history").performClick().assertIsSelected()
        waitFor("Temporarily unable to load")

        val heading = compose.onNodeWithText("Recent automation runs").getUnclippedBoundsInRoot()
        val body = compose.onNodeWithTag("workflow_read_failure").getUnclippedBoundsInRoot()
        val action =
            compose.onNodeWithTag("workflow_use").assertIsEnabled().getUnclippedBoundsInRoot()
        assertEquals(8.dp, body.top - heading.bottom)
        assertEquals(33.dp, action.top - body.bottom)
    }

    @Test
    fun unavailableConnectorAnnouncesTheReadFailureAndReturnsToTheDraft() {
        app.connectorFixture.unavailableCatalogSlugs = setOf("gmail")
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        compose.onNodeWithText("Add automation").performClick()
        selectGmailTrigger()
        val subject = compose.onNodeWithContentDescription("Subject contains")
        subject.performTextReplacement("Release summary")
        waitFor("View connections")
        compose.onNodeWithText("View connections").performClick()

        waitFor("Could not load connectors.")
        val error = compose.onNodeWithText("Could not load connectors.")
        error.assert(
            SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite),
        )
        val paneBounds = compose.onNodeWithTag("connector-detail").getUnclippedBoundsInRoot()
        val errorBounds = error.getUnclippedBoundsInRoot()
        assertEquals(24.dp, errorBounds.top - paneBounds.top)
        assertEquals(12.dp, errorBounds.left - paneBounds.left)
        assertEquals(12.dp, paneBounds.right - errorBounds.right)
        compose.onNodeWithContentDescription("Back").performClick()

        waitFor("View connections")
        subject.assertTextContains("Release summary")
        compose.onNodeWithTag("workflow_save").assertIsNotEnabled()
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun historyShowsConfirmedResultsAndOnlyLinksAvailableSourceChats() {
        val page = app.fixture.firstRunHistory
        val earlierRun =
            page.runs
                .last()
                .copy(
                    id = "b4444444-4444-4444-8444-444444444444",
                    createdAt = "2026-11-20T09:30:00.000Z",
                    status = WorkflowRunHistoryEntryStatus.TIMEOUT,
                    chatThreadId = null,
                )
        app.fixture.firstRunHistory = page.copy(nextCursor = "earlier")
        app.fixture.earlierRunHistory = WorkflowRunHistory(listOf(earlierRun), null)
        openWorkflowDetail()
        assertTrue(app.fixture.requests.none { it.path?.contains("/run-history") == true })

        compose.onNodeWithTag("workflow_tab_history").performClick()
        val sourceTag = "workflow_run_$WORKFLOW_SOURCE_RUN"
        val missingTag = "workflow_run_$WORKFLOW_NO_SOURCE_RUN"
        waitForTag(sourceTag)
        compose.onNodeWithTag(sourceTag).assertTextContains("Running", substring = true)
        compose.onNodeWithTag(missingTag).assertTextContains("Failed", substring = true)
        compose.onNode(hasTestTag(missingTag) and hasClickAction()).assertDoesNotExist()
        val bounds = compose.onNodeWithTag(sourceTag).getUnclippedBoundsInRoot()
        assertEquals(72.dp, bounds.bottom - bounds.top)
        val staticBounds = compose.onNodeWithTag(missingTag).getUnclippedBoundsInRoot()
        assertEquals(72.dp, staticBounds.bottom - staticBounds.top)
        compose.onNodeWithTag("workflow_use").assertIsDisplayed()

        compose.onNodeWithTag("workflow_earlier_runs").performClick()
        val earlierTag = "workflow_run_${earlierRun.id}"
        waitForTag(earlierTag)
        compose.onNodeWithTag(earlierTag).assertTextContains("Timed out", substring = true)
        compose.onNodeWithTag(sourceTag).assertIsDisplayed()
        assertTrue(
            app.fixture.requests.any { it.requestUrl?.queryParameter("cursor") == "earlier" },
        )
    }

    @Test
    fun pendingDraftHandoffDisablesActionsAndReturnsToItsOriginatingTab() {
        app.gate.countDown()
        waitFor("Personal chat")
        compose.onNodeWithContentDescription("Workflows").performClick()
        waitFor("Release checklist")
        compose.onNodeWithTag("workflow_row_$WORKFLOW_RELEASE").performClick()
        waitForTag("workflow_detail_title")
        val history = compose.onNodeWithTag("workflow_tab_history")
        history.performClick()
        val source = hasTestTag("workflow_run_$WORKFLOW_SOURCE_RUN") and hasClickAction()
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

            compose.onNodeWithTag("workflow_tab_automations").performClick().assertIsSelected()
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

        back()
        history.assertIsSelected()
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
        val source = hasTestTag("workflow_run_$WORKFLOW_SOURCE_RUN") and hasClickAction()
        compose.waitUntil(10_000) { compose.onAllNodes(source).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(source).performClick()
        waitForTag("conversation")

        val linkText = hasText("Project handoff", substring = true)
        val link =
            SemanticsMatcher.keyIsDefined(SemanticsProperties.LinkTestMarker) and
                hasAnyAncestor(linkText)
        compose.waitUntil(10_000) {
            compose.onAllNodes(link, useUnmergedTree = true).fetchSemanticsNodes().size == 1
        }
        compose.onNode(linkText).performFirstLinkClick()
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
    fun sourceChatBackRestoresTheFocusedHistoryRow() = withHardwareKeyboard {
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_history").performClick()
        val run = app.fixture.firstRunHistory.runs.last()
        val source = hasTestTag("workflow_run_${run.id}") and hasClickAction()
        compose.waitUntil(10_000) { compose.onAllNodes(source).fetchSemanticsNodes().isNotEmpty() }
        val row = compose.onNode(source)
        row.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        row.performKeyInput { pressKey(Key.Enter) }
        waitForTag("conversation")

        back()
        compose.onNodeWithTag("workflow_tab_history").assertIsSelected()
        row.assertIsFocused()
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
            val source = hasTestTag("workflow_run_$WORKFLOW_SOURCE_RUN") and hasClickAction()
            compose.waitUntil(10_000) {
                compose.onAllNodes(source).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNode(source).performClick()
            waitForTag("conversation")

            compose.onNodeWithContentDescription("Chat actions").performClick()
            compose.onNodeWithText("Delete chat").performClick()
            compose.onNodeWithText("Delete chat").performClick()

            compose.waitUntil(10_000) { requested.count == 0L }
            compose.onNodeWithTag("workflow_tab_history").assertIsSelected()
            compose.onNodeWithTag("conversation").assertDoesNotExist()
            compose.onNode(source).assertDoesNotExist()

            releaseDelete.countDown()
            val rejected = "Could not finish changing the chat."
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(rejected).fetchSemanticsNodes().isNotEmpty()
            }
            val feedback = compose.onNodeWithText(rejected).assertIsDisplayed()
            compose.onNode(source).assertIsDisplayed()

            compose.mainClock.autoAdvance = false
            try {
                compose.mainClock.advanceTimeBy(3_000)
                feedback.assertIsDisplayed()
                val instructions = compose.onNodeWithTag("workflow_tab_instructions")
                instructions.performClick()
                compose.mainClock.advanceTimeBy(250)
                instructions.assertIsSelected()
                feedback.assertIsDisplayed()

                compose.mainClock.advanceTimeBy(2_250)
                feedback.assertDoesNotExist()
            } finally {
                compose.mainClock.autoAdvance = true
            }
        } finally {
            releaseDelete.countDown()
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w412dp-h840dp",
    application = WorkflowRootApplication::class,
)
internal class WorkflowSearchRootTest : WorkflowRootTestFixture() {
    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h800dp")
    fun wideArtifactSearchPreviewKeepsTheWorkflowDraftReturnPath() {
        val fixture = ArtifactApiFixture(app.fixture.chats).apply { install() }
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_automations").performClick()
        compose.onNodeWithTag("workflow_use").performClick()
        waitForTag("message_input")

        compose.onNodeWithTag("workspace_search_entry").performClick()
        val scope = compose.onNodeWithTag("search_type_Artifacts")
        scope.performScrollTo().performClick()
        val query = compose.onNodeWithTag("chat_search_query")
        query.performTextInput("Product launch")
        waitFor(fixture.summary.title)
        compose.onNodeWithText(fixture.summary.title).performClick()
        waitFor("Artifact preview")
        compose.onNodeWithContentDescription("Close artifact preview").performClick()

        query.assertTextContains("Product launch")
        scope.assertIsSelected()
        compose.onNodeWithText(fixture.summary.title).assertIsFocused()
        back()
        compose.onNodeWithTag("chat_search").assertDoesNotExist()
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("/release-review Keep my existing draft")

        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("workflow_tab_automations").assertIsSelected()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h800dp")
    fun wideMessageSearchOpensAChatIndependentlyOfThePreviousWorkflow() {
        val reply = "Project handoff found by search"
        app.fixture.chats.historyReply = reply
        app.fixture.chats.searchMessages = {
            jsonResponse(
                """
                {"results":[{"chatThreadId":"$CHAT_IN_PROJECT","agentName":"Okou",
                  "matchedMessage":{"chatThreadId":"$CHAT_IN_PROJECT","role":"assistant",
                    "content":"$reply","createdAt":"$CHAT_DATE","seqId":23,"runId":"$HISTORY_RUN"},
                  "matchedRanges":[{"start":0,"end":7}]}]}
                """,
            )
        }
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_tab_history").performClick()
        val source = hasTestTag("workflow_run_$WORKFLOW_SOURCE_RUN") and hasClickAction()
        compose.waitUntil(10_000) { compose.onAllNodes(source).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(source).performClick()
        waitForTag("conversation")

        compose.onNodeWithTag("workspace_search_entry").performClick()
        compose.onNodeWithTag("search_type_Messages").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput("Project")
        val hit = hasText(reply) and hasAnyAncestor(hasTestTag("chat_search_results"))
        compose.waitUntil(10_000) { compose.onAllNodes(hit).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hit).performClick()
        waitForTag("conversation_find_hit")
        compose.onNodeWithTag("chat_list").assertIsDisplayed()
        compose.onNodeWithTag("chat_search").assertDoesNotExist()
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h800dp")
    fun wideWorkflowSearchOpensADraftIndependentlyOfThePreviousWorkflow() {
        openWorkflowDetail()
        compose.onNodeWithTag("workflow_use").performClick()
        waitForTag("message_input")
        compose.onNodeWithContentDescription("Back").assertIsDisplayed()

        compose.onNodeWithTag("workspace_search_entry").performClick()
        compose.onNodeWithTag("search_type_Workflows").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput("launch")
        waitFor(app.fixture.releaseTitle)
        compose.onNodeWithText(app.fixture.releaseTitle).performClick()
        compose.onNodeWithText("Add to new chat draft").performClick()

        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("chat_search").fetchSemanticsNodes().isEmpty()
        }
        compose.onNodeWithTag("chat_list").assertIsDisplayed()
        compose
            .onNodeWithTag("message_input")
            .assertTextContains("/release-review Keep my existing draft")
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
    }

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
            },
        )
        back()
        query.assertTextContains("launch")
        scope.assertIsSelected()
        compose.onNodeWithText(renamed).assertIsDisplayed()
    }

    @Test
    fun returningFromWorkflowDetailsShowsSearchFeedbackDuringCatalogRefresh() {
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
            val row = compose.onNodeWithText(originalTitle).assertIsDisplayed()
            val rowTop = row.getUnclippedBoundsInRoot().top
            val loading = hasContentDescription("Searching…")
            val progressSemantics =
                SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)
            val progress = compose.onNode(loading and progressSemantics)
            compose.mainClock.advanceTimeBy(280)
            progress.assertIsDisplayed()
            assertEquals(rowTop, row.getUnclippedBoundsInRoot().top)

            query.performTextReplacement("unmatched query")
            val empty = compose.onNodeWithText("No matching workflows")
            empty.assertDoesNotExist()
            compose.waitForIdle()
            compose.mainClock.advanceTimeBy(280)
            compose.onNode(loading and !progressSemantics).assertIsDisplayed()
            progress.assertDoesNotExist()
            empty.assertDoesNotExist()

            val updatedTitle = "Launch planning"
            app.fixture.releaseTitle = updatedTitle
            releaseCatalog.countDown()
            compose.waitUntilDoesNotExist(loading, 5_000)
            query.assertTextContains("unmatched query")
            scope.assertIsSelected()
            empty.assertIsDisplayed()

            query.performTextReplacement("launch")
            waitFor(updatedTitle)
            row.assertDoesNotExist()
        } finally {
            releaseCatalog.countDown()
        }
    }

    @Test
    fun openIntroductionSurvivesARefreshThatRemovesTheSearchMatch() {
        app.gate.countDown()
        val entry = compose.onNodeWithContentDescription("Search workspace")
        val scope = compose.onNodeWithTag("search_type_Workflows")
        val query = compose.onNodeWithTag("chat_search_query")
        val originalTitle = app.fixture.releaseTitle
        val keyword = "checklist"
        fun search() {
            entry.performClick()
            scope.performClick()
            query.performTextInput(keyword)
            waitFor(originalTitle)
        }

        search()
        compose.onNodeWithContentDescription("Back").performClick()
        val catalogRequested = CountDownLatch(1)
        val releaseCatalog = CountDownLatch(1)
        app.fixture.beforeCatalog = {
            catalogRequested.countDown()
            releaseCatalog.await()
        }
        try {
            search()
            compose.waitUntil(5_000) { catalogRequested.count == 0L }
            compose.onNodeWithText(originalTitle).performClick()
            waitFor("View workflow details")

            val renamed = "Deployment review"
            app.fixture.releaseTitle = renamed
            releaseCatalog.countDown()
            waitFor(renamed)
            compose.onNodeWithText("Add to new chat draft").assertIsDisplayed()
            compose.onNodeWithText("View workflow details").performClick()
            waitForTag("workflow_detail_title")
            compose.onNodeWithTag("workflow_detail_title").assertTextContains(renamed)
            back()

            query.assertTextContains(keyword)
            scope.assertIsSelected()
            waitFor("No matching workflows")
            val focusedResults = hasTestTag("chat_search_results") and isFocused()
            compose.waitUntil(5_000) {
                compose.onAllNodes(focusedResults).fetchSemanticsNodes().isNotEmpty()
            }
        } finally {
            releaseCatalog.countDown()
        }
    }

    @Test
    fun workflowIntroductionClosesWhenRecreationDiscardsTheQuery() {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        val scope = compose.onNodeWithTag("search_type_Workflows")
        val query = compose.onNodeWithTag("chat_search_query")
        val originalTitle = app.fixture.releaseTitle
        val details = compose.onNodeWithText("View workflow details")

        scope.performClick()
        query.performTextReplacement("checklist".padEnd(257))
        waitFor(originalTitle)
        compose.onNodeWithText(originalTitle).performClick()
        details.assertIsDisplayed()

        compose.activityRule.scenario.recreate()

        waitForTag("chat_search_query")
        query.assert(
            SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")),
        )
        details.assertDoesNotExist()

        scope.performClick()
        query.performTextReplacement("checklist")
        waitFor(originalTitle)
        details.assertDoesNotExist()

        compose.onNodeWithText(originalTitle).performClick()
        details.assertIsDisplayed()
        compose.activityRule.scenario.recreate()

        waitFor("View workflow details")
        query.assertTextContains("checklist")
        scope.assertIsSelected()
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
            shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS)
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
            app.fixture.releaseInCatalog = false
            releaseCatalog.countDown()

            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("View workflow details").fetchSemanticsNodes().isEmpty()
            }
            compose.onNodeWithText(originalTitle).assertDoesNotExist()
            compose.onNodeWithTag("chat_search_results").assertIsFocused()
            scope.assertIsSelected()

            query.performTextReplacement("launch")
            waitFor(app.fixture.sharedTitle)
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
    fun workspaceSearchLoadsTheWorkflowIntroWithItsDraftAction() {
        app.gate.countDown()
        waitForTag("workspace_search_entry")
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                ViewModelProvider(compose.activity)[SessionModel::class.java]
                    .uiState
                    .value
                    .ready
                    ?.workflows != null
            }
        }
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("search_type_Workflows").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput("launch")
        waitFor(app.fixture.releaseTitle)
        compose.onNodeWithText(app.fixture.releaseTitle).performClick()
        waitFor("View workflow details")
        compose.onNodeWithText("Add to new chat draft").assertIsEnabled()
        compose.onNodeWithText("View workflow details").assertIsDisplayed()
    }

    @Test
    fun searchWorkflowDraftFailureKeepsTheActionsInPlaceAndRestoresFocus() = withHardwareKeyboard {
        app.gate.countDown()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        val scope = compose.onNodeWithTag("search_type_Workflows")
        val query = compose.onNodeWithTag("chat_search_query")
        scope.performClick()
        query.performTextInput("launch")
        waitFor(app.fixture.releaseTitle)
        val result = compose.onNodeWithText(app.fixture.releaseTitle)
        result.performClick()
        val idleLabel = "Add to new chat draft"
        val pendingLabel = "Opening new chat draft…"
        val error = "Could not open the new chat draft. Your existing draft is preserved."
        waitFor(idleLabel)
        val use = compose.onNodeWithText(idleLabel)
        val opening = compose.onNodeWithText(pendingLabel)
        val details = compose.onNodeWithText("View workflow details")
        val failure = compose.onNodeWithText(error)
        val useBounds = use.getUnclippedBoundsInRoot()
        val detailsBounds = details.getUnclippedBoundsInRoot()

        val firstRead = CountDownLatch(1)
        val releaseFailure = CountDownLatch(1)
        val retryRead = CountDownLatch(1)
        val releaseRetry = CountDownLatch(1)
        try {
            app.fixture.rejectDraftRead = true
            app.fixture.beforeDraftRead = {
                firstRead.countDown()
                check(releaseFailure.await(10, TimeUnit.SECONDS))
            }
            use.assertIsEnabled().pressEnter()
            opening.assertIsNotEnabled()
            compose.waitUntil(5_000) { compose.runOnIdle { firstRead.count == 0L } }
            assertEquals(useBounds, opening.assertIsNotEnabled().getUnclippedBoundsInRoot())
            assertEquals(detailsBounds, details.assertIsNotEnabled().getUnclippedBoundsInRoot())
            releaseFailure.countDown()

            waitFor(error)
            assertTrue(failure.getUnclippedBoundsInRoot().bottom < useBounds.top)
            assertEquals(
                useBounds,
                use.assertIsEnabled().assertIsFocused().getUnclippedBoundsInRoot(),
            )
            assertEquals(detailsBounds, details.assertIsEnabled().getUnclippedBoundsInRoot())
            assertEquals("Keep my existing draft", app.fixture.previousDraft)

            app.fixture.rejectDraftRead = false
            app.fixture.beforeDraftRead = {
                retryRead.countDown()
                check(releaseRetry.await(10, TimeUnit.SECONDS))
            }
            use.performKeyInput { pressKey(Key.Enter) }
            opening.assertIsNotEnabled()
            compose.waitUntil(5_000) { compose.runOnIdle { retryRead.count == 0L } }
            failure.assertDoesNotExist()
            releaseRetry.countDown()
            waitForTag("message_input")
            compose
                .onNodeWithTag("message_input")
                .assertTextContains("/release-review Keep my existing draft")

            back()
            query.assertTextContains("launch")
            scope.assertIsSelected()
            result.assertIsDisplayed().assertIsFocused()
        } finally {
            releaseFailure.countDown()
            releaseRetry.countDown()
        }
    }
}
