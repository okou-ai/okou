package ai.okou.android

import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ChatChanges
import ai.okou.android.chat.ChatListReadFailure
import ai.okou.android.chat.ChatRowAction
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.chat.ProjectDeleteStatus
import android.os.Looper
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeUiTestConfig
import androidx.compose.ui.test.MouseButton
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performFirstLinkClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToKey
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.swipe
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private const val FEEDBACK_TIMEOUT_MILLIS = 5_000L

open class ChatListApplication : TestOkouApplication() {
    lateinit var fixture: ChatListApiFixture
    lateinit var cacheSnapshot: ChatCacheSnapshot
    val responseGate = CountDownLatch(1)

    override fun onCreate() {
        fixture = ChatListApiFixture()
        fixture.beforeResponse = { responseGate.await() }
        chatService = fixture.service
        searchService = fixture.service
        cacheSnapshot = ChatCacheSnapshot(noBackupFilesDir.resolve("chat-list"), chatCache)
        super.onCreate()
    }
}

class ChatListDraftApplication : ChatListApplication() {
    override fun onCreate() {
        super.onCreate()
        composerService = fixture.service
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
internal class ChatRenameFormRootTest : ChatListRootTestFixture() {
    @Test
    fun rejectedChatRenameKeepsEditingStateFromTheListAndConversation() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        val requests = AtomicInteger()
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL/rename") {
                requests.incrementAndGet()
                MockResponse().setResponseCode(400)
            } else null
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val editor = compose.onNode(hasSetTextAction() and hasContentDescription("New name"))
        val failure = "Could not save. Your changes are still here."

        fun rejectRename(proposed: String) {
            compose.onNodeWithText("Rename chat").performClick()
            val save = compose.onNodeWithText("Save")
            save.assertIsNotEnabled()
            editor.performTextReplacement("   Personal chat  ")
            save.assertIsNotEnabled()
            editor.performTextReplacement(proposed)
            editor.performTextInputSelection(TextRange(2, 6))
            editor.assertIsFocused()
            save.performClick()
            compose.waitUntilExactlyOneExists(hasText(failure), 10_000)
            editor.assertTextContains(proposed).assertIsFocused()
            assertEquals(
                TextRange(2, 6),
                editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
            )
            save.assertIsEnabled()
            compose.activityRule.scenario.recreate()
            editor.assertTextContains(proposed).assertIsFocused()
            assertEquals(
                TextRange(2, 6),
                editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
            )
            compose.onNodeWithText("Cancel").performClick()
            compose.onNodeWithText(failure).assertDoesNotExist()
        }

        val personal = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        personal.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        personal.performKeyInput { pressKey(Key.Menu) }
        rejectRename("Draft list title")
        personal.assertIsFocused()
        personal.performClick()
        val actions = compose.onNodeWithContentDescription("Chat actions")
        actions.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        actions.performKeyInput { pressKey(Key.Enter) }
        rejectRename("Draft conversation title")
        actions.assertIsFocused()
        compose.onNodeWithText("Personal chat").assertIsDisplayed()
        assertEquals(2, requests.get())
    }

    @Test
    fun cancellingProjectRenameRestoresTheKeyboardOriginAfterRecreation() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val project = compose.onNodeWithText("Research")
        val editor = compose.onNodeWithContentDescription("Project name")
        project.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        project.performKeyInput { pressKey(Key.Menu) }
        compose.onNodeWithText("Rename").performClick()
        compose.onNodeWithText("Cancel").performClick()
        project.assertIsFocused()

        project.performKeyInput { pressKey(Key.Menu) }
        compose.onNodeWithText("Rename").performClick()
        editor.assertIsFocused()

        compose.activityRule.scenario.recreate()
        editor.assertIsFocused()
        compose.onNodeWithText("Cancel").performClick()

        editor.assertDoesNotExist()
        project.assertIsFocused()
    }

    @Test
    fun chatRenameUsesTheLatestConfirmedNameWhileKeepingEditsAndSelection() {
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performTouchInput { longClick() }
        compose.onNodeWithText("Rename chat").performClick()
        val editor = compose.onNodeWithContentDescription("New name")
        val save = compose.onNodeWithText("Save")
        val saveBounds = save.getUnclippedBoundsInRoot()
        compose.onNodeWithText("Leading and trailing spaces are removed.").assertDoesNotExist()
        editor.performTextReplacement("")
        val required = app.getString(R.string.chat_rename_required)
        compose.onNodeWithText(required, useUnmergedTree = true).assertIsDisplayed()
        editor.assert(SemanticsMatcher.expectValue(SemanticsProperties.Error, required))
        save.assertIsNotEnabled()
        assertEquals(saveBounds, save.getUnclippedBoundsInRoot())
        editor.performTextReplacement("Personal chat")

        fun publishTitle(sequence: Long, eventId: String, title: String) {
            events.add(
                sequence to chatEventWire(eventId, sequence, kind = "renamed", title = title),
            )
            refreshWorkspaceChats()
            compose.waitUntil(10_000) {
                currentList()?.confirmedThreads?.any {
                    it.id == CHAT_PERSONAL && it.title == title
                } == true
            }
        }

        publishTitle(24, HISTORY_LAST_EVENT, "Remote title")
        editor.assertTextContains("Remote title").assertIsFocused()
        save.assertIsNotEnabled()

        editor.performTextReplacement("Personal chat")
        editor.performTextInputSelection(TextRange(1, 4))
        save.assertIsEnabled()
        publishTitle(25, "00000025-0000-4000-8000-000000000000", "Newer title")
        editor.assertTextContains("Personal chat").assertIsFocused()
        assertEquals(
            TextRange(1, 4),
            editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        save.assertIsEnabled()

        publishTitle(26, "00000026-0000-4000-8000-000000000000", "Personal chat")
        editor.assertTextContains("Personal chat")
        save.assertIsNotEnabled()

        editor.performTextReplacement("  Personal chat  ")
        save.assertIsNotEnabled()
        publishTitle(27, "00000027-0000-4000-8000-000000000000", "Final title")
        editor.assertTextContains("Final title")
        save.assertIsNotEnabled()
    }

    @Test
    fun lateCanonicalChatTitleKeepsNewEditsOpen() {
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL/rename")
                MockResponse().setResponseCode(400)
            else null
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val row = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        row.performTouchInput { longClick() }
        compose.onNodeWithText("Rename chat").performClick()
        val editor = compose.onNodeWithContentDescription("New name")
        editor.performTextReplacement("First title")
        compose.onNodeWithText("Save").performClick()
        compose.waitUntilExactlyOneExists(
            hasText("Could not save. Your changes are still here."),
            10_000,
        )

        editor.performTextReplacement("New draft")
        editor.performTextInputSelection(TextRange(0, 3))
        events.add(
            24L to chatEventWire(HISTORY_LAST_EVENT, 24, kind = "renamed", title = "First title"),
        )
        refreshWorkspaceChats()
        compose.waitUntil(10_000) {
            currentList()?.confirmedThreads?.any {
                it.id == CHAT_PERSONAL && it.title == "First title"
            } == true
        }

        editor.assertTextContains("New draft").assertIsFocused()
        assertEquals(
            TextRange(0, 3),
            editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        compose.onNodeWithText("Save").assertIsEnabled()
    }

    @Test
    fun chatRenameClosesWhenItsEventArrivesWithALaterTitle() {
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        val submittedId = AtomicReference<String>()
        val releaseWrite = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL/rename") {
                submittedId.set(request.jsonCommandBody().getValue("eventId").jsonPrimitive.content)
                releaseWrite.await()
                MockResponse().setResponseCode(204)
            } else null
        }
        app.responseGate.countDown()
        awaitListAndNames()

        try {
            val row = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
            row.performTouchInput { longClick() }
            compose.onNodeWithText("Rename chat").performClick()
            val editor = compose.onNodeWithContentDescription("New name")
            editor.performTextReplacement("Submitted title")
            compose.onNodeWithText("Save").performClick()
            compose.waitUntil(10_000) { submittedId.get() != null }
            events.addAll(
                listOf(
                    24L to
                        chatEventWire(
                            checkNotNull(submittedId.get()),
                            24,
                            kind = "renamed",
                            title = "Submitted title",
                        ),
                    25L to
                        chatEventWire(
                            HISTORY_LAST_EVENT,
                            25,
                            kind = "renamed",
                            title = "Newer title",
                        ),
                ),
            )
            refreshWorkspaceChats()
            compose.waitUntil(10_000) {
                currentList()?.confirmedThreads?.any {
                    it.id == CHAT_PERSONAL && it.title == "Newer title"
                } == true
            }

            editor.assertDoesNotExist()
            row.assert(hasText("Newer title"))
            compose.onNodeWithText("Chat title saved").assertIsDisplayed()
            row.performTouchInput { longClick() }
            compose.onNodeWithText("Rename chat").performClick()
            editor.assertTextContains("Newer title")
            compose.onNodeWithText("Save").assertIsNotEnabled()
        } finally {
            releaseWrite.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w760dp-h892dp")
    fun ambiguousChatRenameKeepsTheDraftAndRestoresSave() {
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        val firstEvent = AtomicReference<String>()
        val requests = AtomicInteger()
        val reads = AtomicInteger()
        val readEvents = app.fixture.events
        app.fixture.events = { request ->
            reads.incrementAndGet()
            readEvents(request)
        }
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL/rename") {
                val body = request.jsonCommandBody()
                val name = body.getValue("title").jsonPrimitive.content
                val id = body.getValue("eventId").jsonPrimitive.content
                if (requests.incrementAndGet() == 1) {
                    check(name == "Design notes")
                    firstEvent.set(id)
                    MockResponse().setResponseCode(503)
                } else {
                    check(name == "New draft")
                    check(id != firstEvent.get())
                    events.add(25L to chatEventWire(id, 25, CHAT_PERSONAL, "renamed", title = name))
                    MockResponse().setResponseCode(204)
                }
            } else null
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performTouchInput { longClick() }
        compose.onNodeWithText("Rename chat").performClick()
        val editor = compose.onNodeWithContentDescription("New name")
        editor.assertWidthIsEqualTo(608.dp)
        val bounds = editor.getUnclippedBoundsInRoot()
        assertTrue(bounds.bottom - bounds.top >= 56.dp)
        editor.performTextReplacement("   Design notes  ")
        val selection = TextRange(3, 9)
        editor.performTextInputSelection(selection)
        val save = compose.onNodeWithText("Save")
        val saveBounds = save.getUnclippedBoundsInRoot()
        val beforeSave = reads.get()
        save.performClick()
        val failure = "Could not save. Your changes are still here."
        compose.waitUntilExactlyOneExists(hasText(failure, substring = false), 10_000)
        editor.assertTextContains("   Design notes  ")
        assertEquals(
            selection,
            editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        assertEquals(saveBounds, save.assertIsEnabled().getUnclippedBoundsInRoot())
        assertEquals(beforeSave, reads.get())
        assertEquals(
            "Personal chat",
            currentList()?.threads?.first { it.id == CHAT_PERSONAL }?.title,
        )

        compose.activityRule.scenario.recreate()
        compose.waitUntilExactlyOneExists(hasText(failure, substring = false), 10_000)
        editor.assertTextContains("   Design notes  ").assertIsFocused()
        editor.performTextReplacement("New draft")
        events.add(
            24L to
                chatEventWire(
                    checkNotNull(firstEvent.get()),
                    24,
                    CHAT_PERSONAL,
                    "renamed",
                    title = "Design notes",
                ),
        )
        refreshWorkspaceChats()
        compose.waitUntil(10_000) {
            currentList()?.confirmedThreads?.any {
                it.id == CHAT_PERSONAL && it.title == "Design notes"
            } == true
        }
        editor.assertTextContains("New draft")
        compose.onNodeWithText("Chat title saved").assertDoesNotExist()
        save.assertIsEnabled().performClick()
        compose.waitUntilExactlyOneExists(hasText("Chat title saved"), 10_000)
        editor.assertDoesNotExist()
        compose.onNodeWithText("New draft").assertIsDisplayed()
        assertEquals(2, requests.get())
    }

    @Test
    fun observingTheSavedNameKeepsEditsMadeWhileTheRenameWasPending() {
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        val releaseWrite = CountDownLatch(1)
        val started = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL/rename") {
                val id = request.jsonCommandBody().getValue("eventId").jsonPrimitive.content
                started.countDown()
                releaseWrite.await()
                events.add(
                    24L to
                        chatEventWire(id, 24, CHAT_PERSONAL, "renamed", title = "Submitted title"),
                )
                MockResponse().setResponseCode(204)
            } else null
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performTouchInput { longClick() }
        compose.onNodeWithText("Rename chat").performClick()
        val editor = compose.onNodeWithContentDescription("New name")
        val save = compose.onNodeWithText("Save")
        editor.performTextReplacement("Submitted title")
        try {
            save.performClick()
            compose.waitUntil(10_000) { started.count == 0L }
            compose.onNodeWithText("Saving…").assertIsNotEnabled()
            editor.performTextReplacement("New draft")
            editor.assertTextContains("New draft").assertIsFocused()
        } finally {
            releaseWrite.countDown()
        }
        compose.waitUntilExactlyOneExists(hasText("Save") and isEnabled(), 10_000)
        editor.assertTextContains("New draft").assertIsFocused()
        editor.performTextReplacement("Submitted title")
        save.assertIsNotEnabled()
        editor.assertIsDisplayed()
        compose.onNodeWithText("Chat title saved").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w760dp-h400dp")
    fun chatRenameKeepsTheEditorAndActionsReachableInAShortWindow() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performTouchInput { longClick() }
        compose.onNodeWithText("Rename chat").performClick()
        compose.onNodeWithContentDescription("New name").assertIsDisplayed()
        compose.onNodeWithText("Save").assertIsDisplayed()
        compose.onNodeWithText("Cancel").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back").assertIsDisplayed().performClick()
        compose.onNodeWithContentDescription("New name").assertDoesNotExist()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").assertIsDisplayed()
    }
}

internal abstract class ChatListRootTestFixture {
    protected val animationScale = mutableFloatStateOf(1f)
    private val motion =
        object : MotionDurationScale {
            override val scaleFactor: Float
                get() = animationScale.floatValue
        }

    @get:Rule val compose = createAndroidComposeRule<MainActivity>(ComposeUiTestConfig(motion))
    private var chatJob: Job? = null

    protected fun awaitInlineLink(label: String): SemanticsNodeInteraction {
        val link =
            SemanticsMatcher.keyIsDefined(SemanticsProperties.LinkTestMarker) and
                hasAnyAncestor(hasText(label, substring = true))
        compose.waitUntil(10_000) {
            compose.onAllNodes(link, useUnmergedTree = true).fetchSemanticsNodes().size == 1
        }
        return compose.onNode(link, useUnmergedTree = true)
    }

    @Before
    fun retainActualOwnerForTeardown() {
        compose.onNodeWithContentDescription("Chats").assertExists()
        compose.runOnIdle {
            chatJob =
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready,
                    )
                    .chats
                    .viewModelScope
                    .coroutineContext[Job]
        }
    }

    @After
    fun close() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        val failures = mutableListOf<Throwable>()
        for (cleanup in
            listOf<() -> Unit>(
                { compose.activityRule.scenario.close() },
                {
                    compose.waitUntil(10_000) {
                        shadowOf(Looper.getMainLooper()).idle()
                        chatJob?.isCompleted != false
                    }
                },
                { app.fixture.close() },
                { app.cacheSnapshot.restore() },
            )) {
            try {
                cleanup()
            } catch (error: Throwable) {
                failures += error
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    protected fun setResearchExpanded(expanded: Boolean) {
        val project = hasText("Research")
        val before = if (expanded) SemanticsActions.Expand else SemanticsActions.Collapse
        val after = if (expanded) SemanticsActions.Collapse else SemanticsActions.Expand
        compose.onNodeWithTag("chat_list").performScrollToNode(project)
        compose.onNode(project.and(SemanticsMatcher.keyIsDefined(before))).performClick()
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(project.and(SemanticsMatcher.keyIsDefined(after)))
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
    }

    protected fun awaitRowActionSettled(id: String) {
        val menuAvailable =
            hasTestTag("chat_$id").and(SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick))
        compose.waitUntil(10_000) {
            compose.onAllNodes(menuAvailable).fetchSemanticsNodes().isNotEmpty()
        }
    }

    protected fun RecordedRequest.jsonCommandBody() =
        Json.parseToJsonElement(body.clone().readUtf8()).jsonObject

    protected fun awaitListAndNames() {
        compose.waitUntil(10_000) {
            val state = currentList() ?: return@waitUntil false
            state.confirmedAt != null &&
                state.projectsPhase != ai.okou.android.chat.ChatReadPhase.Loading &&
                state.indicatorsPhase != ai.okou.android.chat.ChatReadPhase.Loading
        }
    }

    protected fun currentList() = compose.runOnIdle {
        ViewModelProvider(compose.activity)[SessionModel::class.java]
            .uiState
            .value
            .ready
            ?.chats
            ?.uiState
            ?.value
    }

    protected fun refreshWorkspaceChats() {
        compose.runOnIdle {
            checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready,
                )
                .chats
                .refresh()
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w1000dp-h800dp",
    application = ChatListDraftApplication::class,
)
internal class ChatListDraftRootTest : ChatListRootTestFixture() {
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun wideSingleLineComposerMatchesTheFloatingActionHeightAndBottom() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val newChat = compose.onNode(hasText("New chat") and hasClickAction())
        val composer = compose.onNodeWithTag("chat_input_card", useUnmergedTree = true)
        val editor = hasTestTag("message_input") and hasSetTextAction()
        fun assertAligned() {
            compose.waitUntilExactlyOneExists(editor, 10_000)
            val action = newChat.assertIsDisplayed().getUnclippedBoundsInRoot()
            val card = composer.assertIsDisplayed().getUnclippedBoundsInRoot()
            assertEquals(56.dp, action.bottom - action.top)
            assertEquals(action.top, card.top)
            assertEquals(action.bottom, card.bottom)
        }
        assertAligned()

        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performClick().assertIsSelected()
        assertAligned()
        compose.onNode(editor).performTextInput("Draft")
        assertAligned()
    }

    @Test
    fun openedChatsDraftReadUpdatesTheMarkerAfterAnOlderIndex() {
        val app = compose.activity.application as ChatListApplication
        val webDraft = "Draft saved on Web"
        app.responseGate.countDown()
        awaitListAndNames()
        compose.waitUntil(10_000) { currentList()?.draftThreadIds?.isEmpty() == true }

        val row = hasTestTag("chat_$CHAT_PERSONAL")
        val glyph =
            compose.onNode(
                hasTestTag("chat_draft_icon") and hasAnyAncestor(row),
                useUnmergedTree = true,
            )
        glyph.assertDoesNotExist()
        app.fixture.setThreadDraft(CHAT_PERSONAL, webDraft)
        compose.onNode(row).performClick().assertIsSelected()
        compose.waitUntilExactlyOneExists(
            hasTestTag("message_input") and hasSetTextAction() and hasText(webDraft),
            10_000,
        )
        glyph.assertIsDisplayed()
    }

    @Test
    fun draftMarkerAppearsBesideTheTitleAndKeepsTheActivityState() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.setThreadDraft(CHAT_PERSONAL, "Existing draft")
        val releaseIndex = CountDownLatch(1)
        app.fixture.draftIndex = {
            releaseIndex.await()
            jsonResponse("""{"draftThreadIds":["$CHAT_PERSONAL"]}""")
        }
        val rowTag = hasTestTag("chat_$CHAT_PERSONAL")
        val row = compose.onNode(rowTag)
        val title =
            compose.onNode(
                hasText("Personal chat") and hasAnyAncestor(rowTag),
                useUnmergedTree = true,
            )
        val glyph =
            compose.onNode(
                hasTestTag("chat_draft_icon") and hasAnyAncestor(rowTag),
                useUnmergedTree = true,
            )
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            glyph.assertDoesNotExist()
            val before = title.getUnclippedBoundsInRoot()
            val rowBounds = row.getUnclippedBoundsInRoot()
            assertEquals(16.dp, before.left - rowBounds.left)
            assertEquals(56.dp, rowBounds.bottom - rowBounds.top)
            val activity = row.fetchSemanticsNode().config[SemanticsProperties.StateDescription]

            releaseIndex.countDown()
            compose.waitUntil(10_000) { currentList()?.draftThreadIds == setOf(CHAT_PERSONAL) }
            row.performClick().assertIsSelected()
            val icon = glyph.getUnclippedBoundsInRoot()
            val marked = title.getUnclippedBoundsInRoot()
            assertEquals(18.dp, icon.right - icon.left)
            assertEquals(8.dp, marked.left - icon.right)
            assertEquals(26.dp, marked.left - before.left)
            assertEquals(rowBounds, row.getUnclippedBoundsInRoot())
            assertEquals(
                "$activity, Has draft",
                row.fetchSemanticsNode().config[SemanticsProperties.StateDescription],
            )

            val editor = compose.onNode(hasTestTag("message_input") and hasSetTextAction())
            compose.waitUntilExactlyOneExists(
                hasTestTag("message_input") and hasSetTextAction(),
                10_000,
            )
            editor.performTextInput("A local draft")
            editor.performTextReplacement("")
            glyph.assertDoesNotExist()
            assertEquals(before.left, title.getUnclippedBoundsInRoot().left)
            assertEquals(
                activity,
                row.fetchSemanticsNode().config[SemanticsProperties.StateDescription],
            )
            editor.performTextInput("A local draft")
            glyph.assertExists()
        } finally {
            releaseIndex.countDown()
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = ChatListApplication::class)
internal class ChatListRootTest : ChatListRootTestFixture() {
    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun inPlaceRowMenuActionReturnsFocusToItsKeyboardTrigger() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val target = hasTestTag("chat_$CHAT_PERSONAL")
        compose.onNodeWithTag("chat_list").performScrollToNode(target)
        val row = compose.onNode(target)
        row.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        row.performKeyInput { pressKey(Key.Menu) }
        compose.onNodeWithText("Pin chat").performClick()
        row.assertIsFocused()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun projectKeepsItsTitleBoundsAndKeyboardFocusWhenItsStatusRefreshes() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        val name = "Research notes and interview summaries for the next product planning review"
        app.fixture.projects = {
            jsonResponse(
                """{"projects":[{"id":"$CHAT_PROJECT","name":"$name","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}""",
            )
        }
        val running = AtomicBoolean(false)
        app.fixture.indicators = {
            if (running.get())
                jsonResponse("""{"threads":{"$CHAT_IN_PROJECT":"active"},"unreadAt":{}}""")
            else jsonResponse("""{"threads":{},"unreadAt":{}}""")
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val project = compose.onNodeWithText(name)
        val title = compose.onNodeWithText(name, useUnmergedTree = true)
        project.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        val before = title.getUnclippedBoundsInRoot()
        val header = project.getUnclippedBoundsInRoot()
        assertEquals(56f, (header.bottom - header.top).value, 1f)

        running.set(true)
        (app.realtimeService as TestRealtimeService).invalidate(ChatChanges(indicators = true))
        val active = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Active 1")
        compose.waitUntilExactlyOneExists(hasText(name) and active, 10_000)
        project.assertIsFocused()
        assertEquals(before, title.getUnclippedBoundsInRoot())
        assertEquals(header, project.getUnclippedBoundsInRoot())
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun projectToggleReflowsFollowingRowsWhileKeepingItsKeyboardFocus() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val expansion = compose.runOnIdle {
            checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready,
                )
                .projectExpansion
        }
        compose.waitUntil(10_000) { expansion.state.value.expandedIds != null }
        val heading = hasText("Research")
        val project = compose.onNode(heading)
        val followingChat = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        project.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        val header = project.getUnclippedBoundsInRoot()
        val collapsedTop = followingChat.getUnclippedBoundsInRoot().top
        compose.mainClock.autoAdvance = false
        try {
            fun toggle(key: Key, newAction: SemanticsPropertyKey<*>) {
                project.performKeyInput { pressKey(key) }
                val updated = heading.and(SemanticsMatcher.keyIsDefined(newAction))
                compose.waitUntil(10_000) {
                    compose.mainClock.advanceTimeByFrame()
                    compose.onAllNodes(updated).fetchSemanticsNodes().isNotEmpty()
                }
                compose.mainClock.advanceTimeBy(64)
                project.assertIsFocused()
                assertEquals(header, project.getUnclippedBoundsInRoot())
            }

            toggle(Key.Enter, SemanticsActions.Collapse)
            val openingTop = followingChat.getUnclippedBoundsInRoot().top
            compose.mainClock.advanceTimeBy(250)
            val expandedTop = followingChat.getUnclippedBoundsInRoot().top
            assertTrue(
                "Opening row is in motion: $collapsedTop, $openingTop, $expandedTop",
                openingTop > collapsedTop && openingTop < expandedTop,
            )

            val child = compose.onNodeWithTag("chat_$CHAT_IN_PROJECT").getUnclippedBoundsInRoot()
            assertEquals(24f, (child.left - header.left).value, 1f)
            assertEquals(56f, (child.bottom - child.top).value, 1f)

            toggle(Key.Spacebar, SemanticsActions.Expand)
            val closingTop = followingChat.getUnclippedBoundsInRoot().top
            assertTrue(
                "Closing row is in motion: $collapsedTop, $closingTop, $expandedTop",
                closingTop > collapsedTop && closingTop < expandedTop,
            )
            compose.mainClock.advanceTimeBy(250)
            assertEquals(collapsedTop, followingChat.getUnclippedBoundsInRoot().top)
            compose.onNodeWithTag("chat_$CHAT_IN_PROJECT").assertDoesNotExist()

            compose.runOnIdle { animationScale.floatValue = 0f }
            toggle(Key.Enter, SemanticsActions.Collapse)
            assertEquals(expandedTop, followingChat.getUnclippedBoundsInRoot().top)
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w320dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun workspaceToolEntriesAreVisibleWithArtifactsEnabled() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val labels = listOf("Workflows", "Connectors", "Artifacts")
        val entries = labels.map {
            val entry = compose.onNodeWithContentDescription(it).assertIsDisplayed()
            if (it == "Artifacts") entry.assertIsEnabled()
            else entry.assertIsNotEnabled().assertHasNoClickAction()
            entry
        }
        val search = compose.onNodeWithContentDescription("Search workspace")
        val searchBounds = search.getUnclippedBoundsInRoot()
        val entryBounds = entries.map { it.getUnclippedBoundsInRoot() }
        assertTrue(entryBounds.all { it.top >= searchBounds.bottom && it.bottom - it.top >= 48.dp })
        assertTrue(entryBounds.zipWithNext().all { (start, end) -> start.right < end.left })
        for ((label, bounds) in labels.zip(entryBounds)) {
            val title = compose.onNodeWithText(label, useUnmergedTree = true)
            val titleBounds = title.getUnclippedBoundsInRoot()
            val layouts = mutableListOf<TextLayoutResult>()
            title.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertEquals(1, layouts.single().lineCount)
            assertEquals(
                (bounds.top + bounds.bottom).value / 2,
                (titleBounds.top + titleBounds.bottom).value / 2,
                1f,
            )
        }
        search.performClick()
        entries.forEach { it.assertDoesNotExist() }
        compose.onNodeWithContentDescription("Back").performClick()
        entries.forEach { it.assertIsDisplayed() }
    }

    @Test
    @Config(qualifiers = "en-rUS-w280dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun connectorLabelFitsOnTheNarrowChatList() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val connectorLabel = "Connectors"
        val connectorLayouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(connectorLabel, useUnmergedTree = true).performSemanticsAction(
            SemanticsActions.GetTextLayoutResult,
        ) {
            it(connectorLayouts)
        }
        val connectorLayout = connectorLayouts.single()
        assertEquals(1, connectorLayout.lineCount)
        assertEquals(connectorLabel.length, connectorLayout.getLineEnd(0, visibleEnd = true))
        assertTrue(connectorLayout.size.width >= connectorLayout.multiParagraph.maxIntrinsicWidth)
    }

    @Test
    @Config(qualifiers = "en-rUS-w900dp-h800dp")
    fun heldHistoryWarmingFailureKeepsFirstDisplayAndSelectedConversationUsable() {
        val app = compose.activity.application as ChatListApplication
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        app.fixture.historyCatchUp = {
            entered.countDown()
            release.await()
            okhttp3.mockwebserver.MockResponse().setResponseCode(503)
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            compose.waitUntil(10_000) { compose.runOnIdle { entered.count == 0L } }
            compose.onNodeWithContentDescription("Chats").assertExists()
            org.junit.Assert.assertEquals(0, app.fixture.readRequests.get())
            val chats = compose.runOnIdle {
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready,
                    )
                    .chats
            }
            compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Personal chat"))
            compose.onNodeWithText("Personal chat").performClick()
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    chats.history.uiState.value.phase == ai.okou.android.chat.HistoryPhase.Ready
                }
            }
            compose
                .onNodeWithTag("conversation")
                .performScrollToNode(hasText("Native history", substring = true))
            compose.onNodeWithText("Native history", substring = true).assertExists()
            compose.openChatListSettings()
            compose.onNodeWithText("Display mode").assertExists()
            release.countDown()
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    chats.warming.state.value.phase == ai.okou.android.chat.ChatReadPhase.Failed
                }
            }
            compose.onNodeWithText("Display mode").assertExists()
            compose.onNodeWithContentDescription("Back").performClick()
            compose
                .onNodeWithTag("conversation")
                .performScrollToNode(hasText("Native history", substring = true))
            compose.onNodeWithText("Native history", substring = true).assertExists()
        } finally {
            release.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w900dp-h800dp")
    fun selectedConversationKeepsNavigationUsableAndOnlyVisibleConfirmedContentMarksRead() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val historyRequested = CountDownLatch(1)
        val gate = CountDownLatch(1)
        val refreshGate = CountDownLatch(1)
        val indicatorReads = AtomicInteger()
        fixture.indicators = {
            indicatorReads.incrementAndGet()
            if (fixture.readRequests.get() == 0) {
                jsonResponse(
                    """{"threads":{"$CHAT_IN_PROJECT":"unread"},"unreadAt":{"$CHAT_IN_PROJECT":"$CHAT_DATE"}}""",
                )
            } else jsonResponse("""{"threads":{},"unreadAt":{}}""")
        }
        val snapshotResponse = fixture.historySnapshot
        val rowsResponse = fixture.historyRows
        val catchUpResponse = fixture.historyCatchUp
        fun awaitHistoryResponse() {
            historyRequested.countDown()
            gate.await()
        }
        fixture.historySnapshot = {
            awaitHistoryResponse()
            snapshotResponse()
        }
        fixture.historyRows = { request ->
            awaitHistoryResponse()
            rowsResponse(request)
        }
        fixture.historyCatchUp = { request ->
            awaitHistoryResponse()
            catchUpResponse(request)
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            setResearchExpanded(true)
            compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Project chat"))
            compose.onNodeWithText("Project chat").performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { historyRequested.count == 0L } }
            compose.onNodeWithTag("conversation").assertExists()
            val loadingLabel = app.getString(R.string.history_loading)
            compose.mainClock.advanceTimeBy(160)
            compose.waitUntilExactlyOneExists(hasContentDescription(loadingLabel), 5_000)
            compose.openChatListSettings()
            compose.onNodeWithText("Display mode").assertExists()
            gate.countDown()
            val chats = compose.runOnIdle {
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready,
                    )
                    .chats
            }
            val model = chats.history
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    model.uiState.value.phase != ai.okou.android.chat.HistoryPhase.Loading
                }
            }
            org.junit.Assert.assertEquals(
                model.uiState.value.toString(),
                ai.okou.android.chat.HistoryPhase.Ready,
                model.uiState.value.phase,
            )
            org.junit.Assert.assertEquals(0, app.fixture.readRequests.get())
            compose.onNodeWithContentDescription("Back").performClick()
            compose
                .onNodeWithTag("conversation")
                .performScrollToNode(hasText("Native history", substring = true))
            compose.onNodeWithText("Native history", substring = true).assertExists()
            compose.waitUntil(10_000) { compose.runOnIdle { app.fixture.readRequests.get() >= 1 } }
            org.junit.Assert.assertEquals(1, app.fixture.readRequests.get())
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    chats.uiState.value.indicatorsPhase ==
                        ai.okou.android.chat.ChatReadPhase.Ready &&
                        chats.uiState.value.indicators?.threads?.isEmpty() == true
                }
            }
            org.junit.Assert.assertTrue(indicatorReads.get() >= 2)
            compose.onNodeWithTag("conversation").performScrollToIndex(1)
            val message = compose.onNodeWithText("Hello history")
            val input = compose.onNode(hasTestTag("message_input") and hasSetTextAction())
            val messageBounds = message.getUnclippedBoundsInRoot()
            val inputBounds = input.getUnclippedBoundsInRoot()
            val refreshRequested = CountDownLatch(1)
            fixture.historyRows = { request ->
                refreshRequested.countDown()
                refreshGate.await()
                rowsResponse(request)
            }
            compose.runOnIdle { model.refresh() }
            compose.waitUntil(10_000) { refreshRequested.count == 0L }
            compose.mainClock.advanceTimeBy(300)
            compose.onNodeWithContentDescription(loadingLabel).assertDoesNotExist()
            assertEquals(messageBounds, message.getUnclippedBoundsInRoot())
            assertEquals(inputBounds, input.getUnclippedBoundsInRoot())
            refreshGate.countDown()
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    model.uiState.value.phase != ai.okou.android.chat.HistoryPhase.Loading
                }
            }
            assertEquals(
                model.uiState.value.toString(),
                ai.okou.android.chat.HistoryPhase.Ready,
                model.uiState.value.phase,
            )
            assertEquals(messageBounds, message.getUnclippedBoundsInRoot())
            assertEquals(inputBounds, input.getUnclippedBoundsInRoot())
            compose.onNodeWithTag("conversation").assertExists()
            compose.onNodeWithTag("chat_list").assertExists()
            val projectChat = compose.onNodeWithTag("chat_$CHAT_IN_PROJECT")
            projectChat.assertExists()
            setResearchExpanded(false)
            projectChat.assertDoesNotExist()
            setResearchExpanded(true)
            projectChat.assertExists()
        } finally {
            gate.countDown()
            refreshGate.countDown()
            fixture.historyRows = rowsResponse
            fixture.historySnapshot = snapshotResponse
            fixture.historyCatchUp = catchUpResponse
        }
    }

    @Test
    fun unavailableProjectsDoNotRevokeTheWorkspaceOrHideAuthorizedOutsideChats() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.projects = {
            jsonResponse("""{"error":{"code":"NOT_FOUND","message":"Project not found"}}""")
                .setResponseCode(404)
        }
        app.responseGate.countDown()
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Project information is temporarily unavailable.")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        awaitListAndNames()
        compose
            .onNode(
                hasText("Project information is temporarily unavailable.") and
                    hasAnyAncestor(hasTestTag("chat_list_feedback")),
            )
            .assertIsDisplayed()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Personal chat"))
        compose.onNodeWithText("Personal chat").assertExists()
        compose.openChatListSettings()
        compose.onNodeWithText("Display mode").assertExists()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun lateProjectHeadersPreserveTheVisibleChatAndItsOffset() {
        val app = compose.activity.application as ChatListApplication
        val projectRequested = CountDownLatch(1)
        val projectGate = CountDownLatch(1)
        val projectResponse = app.fixture.projects
        app.fixture.projects = {
            projectRequested.countDown()
            projectGate.await()
            projectResponse()
        }
        val rows =
            (1..190).joinToString(",") { index ->
                val suffix = index.toString().padStart(12, '0')
                chatEventWire(
                    id = "61000000-0000-4000-8000-$suffix",
                    seq = index.toLong(),
                    thread = "62000000-0000-4000-8000-$suffix",
                    title = "Startup chat $index",
                    extra = if (index <= 160) ",\"projectId\":\"$CHAT_PROJECT\"" else "",
                )
            }
        app.fixture.events = { request ->
            val events = if (request.requestUrl?.queryParameter("sinceSeqId") == null) rows else ""
            jsonResponse("""{"events":[$events],"hasMore":false}""")
        }
        try {
            app.responseGate.countDown()
            compose.waitUntil(10_000) {
                projectRequested.count == 0L &&
                    currentList()?.source == ai.okou.android.chat.ChatListSource.Network
            }
            val list = compose.onNodeWithTag("chat_list")
            val projectChat = compose.onNodeWithText("Startup chat 160")
            projectChat.assertIsDisplayed()
            val projectInset = projectChat.fetchSemanticsNode().boundsInRoot.left
            compose.onNodeWithText("Research").assertDoesNotExist()

            // The header will replace 160 rows, taking the anchor outside Compose's key window.
            list.performScrollToIndex(165)
            list.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 12f) }
            val anchor = compose.onNodeWithText("Startup chat 185")
            anchor.assertIsDisplayed()
            val anchorBounds = anchor.getUnclippedBoundsInRoot()
            assertTrue(projectInset > anchor.fetchSemanticsNode().boundsInRoot.left)
            projectGate.countDown()
            awaitListAndNames()
            assertEquals(anchorBounds, anchor.getUnclippedBoundsInRoot())

            list.performScrollToIndex(0)
            compose.onNodeWithText("Research").assertIsDisplayed()
            projectChat.assertDoesNotExist()
            setResearchExpanded(true)
            projectChat.assertIsDisplayed()
            assertEquals(projectInset, projectChat.fetchSemanticsNode().boundsInRoot.left)
        } finally {
            projectGate.countDown()
        }
    }

    @Test
    fun expiredSignedStorageKeepsTheWorkspaceOpenAndRetriesWithAFreshDescriptor() {
        val app = compose.activity.application as ChatListApplication
        val descriptors = AtomicInteger()
        val archives = AtomicInteger()
        val finishArchive = CountDownLatch(1)
        app.fixture.snapshot = {
            val url = app.fixture.server.url("/archive?attempt=${descriptors.incrementAndGet()}")
            jsonResponse(
                """{"url":"$url","expiresInSeconds":60,"latestEventId":null,"latestSeqId":null}""",
            )
        }
        app.fixture.archive = {
            if (archives.incrementAndGet() == 1) MockResponse().setResponseCode(403)
            else {
                finishArchive.await()
                jsonResponse("""{"chatThreads":[]}""")
            }
        }
        try {
            compose.onNodeWithContentDescription("Search workspace").performClick()
            app.responseGate.countDown()
            compose.waitUntil(10_000) {
                currentList()?.listReadFailure == ChatListReadFailure.Retrying
            }
            compose.mainClock.advanceTimeBy(280)
            compose
                .onNodeWithContentDescription(app.getString(R.string.chat_loading))
                .assertIsDisplayed()
            compose
                .onNodeWithText(app.getString(R.string.chat_list_first_load_failed))
                .assertDoesNotExist()
            compose.onNodeWithTag("chat_search").assertExists()
            shadowOf(Looper.getMainLooper()).idleFor(3, TimeUnit.SECONDS)
            compose.waitUntil(10_000) { archives.get() >= 2 }
        } finally {
            finishArchive.countDown()
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Project chat").fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(descriptors.get() >= 2)
        compose.onNodeWithContentDescription("Back").performClick()
        compose.openChatListSettings()
        compose.onNodeWithText("Display mode").assertExists()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1280dp-h800dp")
    fun wideConversationSyncProgressSpansThePaneAndPreservesContentBounds() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        compose.waitUntilExactlyOneExists(hasText("Hello history"), 10_000)
        val history = compose.runOnIdle {
            checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready
                        ?.chats,
                )
                .history
        }
        compose.waitUntil(5_000) {
            compose.runOnIdle { history.uiState.value.phase == HistoryPhase.Ready }
        }
        val timeline = compose.onNodeWithTag("conversation")
        val composer = compose.onNodeWithTag("chat_composer")
        val reply = compose.onNodeWithText("Hello history")
        val timelineBounds = timeline.getUnclippedBoundsInRoot()
        val composerBounds = composer.getUnclippedBoundsInRoot()
        val replyBounds = reply.getUnclippedBoundsInRoot()
        val sync = hasContentDescription(compose.activity.getString(R.string.history_syncing))
        val successfulRows = app.fixture.historyRows
        app.fixture.historyRows = { MockResponse().setResponseCode(503) }
        try {
            compose.runOnIdle { history.refresh() }
            for (failures in 1..3) {
                compose.waitUntil(5_000) {
                    compose.runOnIdle {
                        history.uiState.value.consecutiveReadFailures >= failures
                    }
                }
                if (failures < 3) {
                    compose.onNode(sync).assertDoesNotExist()
                    shadowOf(Looper.getMainLooper()).idleFor(3, TimeUnit.SECONDS)
                }
            }

            compose.onNode(sync).assertIsDisplayed()
            val bar = compose.onNodeWithTag("history_sync_progress").getUnclippedBoundsInRoot()
            val list = compose.onNodeWithTag("chat_list").getUnclippedBoundsInRoot()
            assertEquals(list.right + 1.dp, bar.left)
            assertEquals(compose.onRoot().getUnclippedBoundsInRoot().right, bar.right)
            assertEquals(timelineBounds.top, bar.top)
            assertEquals(4.dp, bar.bottom - bar.top)
            assertEquals(768.dp, timelineBounds.right - timelineBounds.left)
            assertEquals(timelineBounds, timeline.getUnclippedBoundsInRoot())
            assertEquals(composerBounds, composer.getUnclippedBoundsInRoot())
            assertEquals(replyBounds, reply.getUnclippedBoundsInRoot())
        } finally {
            app.fixture.historyRows = successfulRows
        }
        shadowOf(Looper.getMainLooper()).idleFor(6, TimeUnit.SECONDS)
        compose.waitUntilDoesNotExist(sync, 5_000)
        assertEquals(replyBounds, reply.getUnclippedBoundsInRoot())
        assertEquals(composerBounds, composer.getUnclippedBoundsInRoot())
    }

    @Test
    fun heldTransportKeepsNavigationAndRestoresTheListWithProjectStatus() {
        compose.onNodeWithContentDescription("Chats").assertExists()
        val skeleton = compose.onNodeWithContentDescription("Loading chats…")
        compose.mainClock.advanceTimeBy(160)
        skeleton.assertDoesNotExist()
        compose.mainClock.advanceTimeBy(144)
        skeleton.assertExists()
        compose.onNodeWithContentDescription("Switch workspace", substring = true).performClick()
        compose.onNodeWithText("Workspace B").assertExists()
        compose.onNode(hasText("Workspace A") and isSelectable()).assertIsSelected().performClick()
        compose.openChatListSettings()
        compose.onNodeWithText("Display mode").assertExists()
        (compose.activity.application as ChatListApplication).responseGate.countDown()
        compose.onNodeWithContentDescription("Back").performClick()
        awaitListAndNames()
        val unread = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread")
        val projectUnreadCount =
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread 1")
        fun assertProjectWeight(expected: FontWeight) {
            val layouts = mutableListOf<TextLayoutResult>()
            compose.onNodeWithText("Research", useUnmergedTree = true).performSemanticsAction(
                SemanticsActions.GetTextLayoutResult,
            ) {
                it(layouts)
            }
            assertEquals(expected, layouts.single().layoutInput.style.fontWeight)
        }
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Research"))
        compose.onNodeWithText("Research").assert(projectUnreadCount)
        assertProjectWeight(FontWeight.SemiBold)
        compose.onNodeWithText("Project chat").assertDoesNotExist()
        setResearchExpanded(true)
        assertProjectWeight(FontWeight.Normal)
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Project chat"))
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasText("Project chat").and(unread))
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithText("Project chat").assert(unread)
        setResearchExpanded(false)
        compose.onNodeWithText("Research").assert(projectUnreadCount)
        assertProjectWeight(FontWeight.SemiBold)
        compose.onNodeWithText("Project chat").assertDoesNotExist()
        compose.onNodeWithTag("chat_list").performScrollToIndex(0)
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("No archived chats"))
        compose.onNodeWithText("No archived chats").assertExists()
        compose.activityRule.scenario.recreate()
        awaitListAndNames()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("No archived chats"))
        compose.onNodeWithText("No archived chats").assertExists()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun aTerminalRefreshNotifiesOnceAndKeepsAnEmptyFilterVisible() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Archived").performClick()
        val empty = compose.onNodeWithText("No archived chats")
        val emptyBounds = empty.getUnclippedBoundsInRoot()
        val notice = compose.activity.getString(R.string.chat_list_sync_failed)
        val normalEvents = app.fixture.events

        app.fixture.events = { okhttp3.mockwebserver.MockResponse().setResponseCode(503) }
        refreshWorkspaceChats()

        compose.waitUntil(10_000) {
            currentList()?.listPhase == ai.okou.android.chat.ChatReadPhase.Failed
        }
        compose.onNodeWithTag("chat_filter_heading").assert(hasText("Archived"))
        empty.assertExists()
        compose.onNodeWithText(notice).assertDoesNotExist()
        compose.onNodeWithContentDescription("Syncing chats…").assertDoesNotExist()

        app.fixture.events = { MockResponse().setResponseCode(400) }
        shadowOf(Looper.getMainLooper()).idleFor(3, TimeUnit.SECONDS)
        compose.waitUntilExactlyOneExists(hasText(notice), 10_000)
        assertEquals(emptyBounds, empty.getUnclippedBoundsInRoot())
        compose.onNodeWithTag("chat_list_first_read_status").assertDoesNotExist()

        app.fixture.events = normalEvents
        refreshWorkspaceChats()
        compose.waitUntilDoesNotExist(hasText(notice), 10_000)
        assertEquals(emptyBounds, empty.getUnclippedBoundsInRoot())

        app.fixture.events = { MockResponse().setResponseCode(400) }
        refreshWorkspaceChats()
        compose.waitUntilExactlyOneExists(hasText(notice), 10_000)
        compose.onNodeWithText("Back to Inbox").performClick()
        compose.onNodeWithText("Personal chat").assertIsDisplayed()
        compose.onNodeWithText(notice).assertDoesNotExist()
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Archived").performClick()
        empty.assertIsDisplayed()
        compose.onNodeWithText(notice).assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h560dp")
    fun returningToInboxRestoresItsScrollPosition() {
        val app = compose.activity.application as ChatListApplication
        val rows =
            (1..24).joinToString(",") { index ->
                val suffix = index.toString().padStart(12, '0')
                chatEventWire(
                    id = "61000000-0000-4000-8000-$suffix",
                    seq = index.toLong(),
                    thread = "62000000-0000-4000-8000-$suffix",
                    title = "Inbox chat $index",
                )
            }
        app.fixture.events = { request ->
            val events = if (request.requestUrl?.queryParameter("sinceSeqId") == null) rows else ""
            jsonResponse("""{"events":[$events],"hasMore":false}""")
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val list = compose.onNodeWithTag("chat_list")
        val chat = "Inbox chat 12"
        list.performScrollToNode(hasText(chat))
        val row = compose.onNodeWithText(chat).assertIsDisplayed()
        val top = row.fetchSemanticsNode().boundsInRoot.top
        val filter = compose.onNodeWithContentDescription("Filter")
        filter.performClick()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithTag("chat_filter_heading").assert(hasText("Archived"))
        compose.onNodeWithText("No archived chats").assertIsDisplayed()
        compose.onNodeWithText("Back to Inbox").performClick()
        row.assertIsDisplayed()
        assertEquals(top, row.fetchSemanticsNode().boundsInRoot.top)
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun initialUnreadKeepsItsSkeletonThroughTemporaryFailuresAndRecoversAutomatically() {
        val app = compose.activity.application as ChatListApplication
        val attempts = AtomicInteger()
        val firstRead = CountDownLatch(1)
        val indicators = app.fixture.indicators
        app.fixture.indicators = {
            val attempt = attempts.incrementAndGet()
            if (attempt == 1) firstRead.await()
            if (attempt <= 3) MockResponse().setResponseCode(503) else indicators()
        }
        val filter = compose.onNodeWithContentDescription("Filter")
        try {
            app.responseGate.countDown()
            compose.waitUntil(10_000) { currentList()?.confirmedAt != null }
            compose.onNodeWithText("Personal chat").assertIsDisplayed()
            filter.performClick()
            compose.onNodeWithText("Unread").performClick()
            val loading = compose.activity.getString(R.string.chat_loading)
            compose.waitUntilExactlyOneExists(hasContentDescription(loading), 10_000)
            val skeleton = compose.onNodeWithContentDescription(loading)
            val loadingBounds = skeleton.getUnclippedBoundsInRoot()
            val toolbarBounds = filter.getUnclippedBoundsInRoot()

            firstRead.countDown()
            compose.waitUntil(10_000) { currentList()?.indicatorsRetryProgressVisible == true }
            assertEquals(3, attempts.get())
            assertEquals(loadingBounds, skeleton.getUnclippedBoundsInRoot())
            compose
                .onNodeWithContentDescription(compose.activity.getString(R.string.chat_syncing))
                .assertDoesNotExist()
            compose.onNodeWithTag("chat_list_first_read_status").assertDoesNotExist()
            compose.onNodeWithText("No unread chats").assertDoesNotExist()
            assertEquals(toolbarBounds, filter.getUnclippedBoundsInRoot())

            awaitListAndNames()
            assertEquals(4, attempts.get())
            skeleton.assertDoesNotExist()
            setResearchExpanded(true)
            compose.onNodeWithText("Project chat").assertIsDisplayed()
        } finally {
            firstRead.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun indicatorRetriesStayQuietAndTerminalFailureKeepsTheConfirmedFilter() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        app.fixture.indicators = { MockResponse().setResponseCode(503) }
        (app.realtimeService as TestRealtimeService).invalidate(ChatChanges(indicators = true))
        val mainLooper = shadowOf(Looper.getMainLooper())
        compose.waitUntil(10_000) {
            mainLooper.idleFor(3, TimeUnit.SECONDS)
            currentList()?.indicatorsRetryProgressVisible == true
        }

        val refreshFailure =
            compose.onNodeWithText(compose.activity.getString(R.string.chat_refresh_failed))
        val syncBar =
            compose.onNodeWithContentDescription(compose.activity.getString(R.string.chat_syncing))
        compose.onNodeWithText("Personal chat").assertIsDisplayed()
        refreshFailure.assertDoesNotExist()
        syncBar.assertDoesNotExist()

        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Archived").performClick()
        val empty = compose.onNodeWithText("No archived chats")
        empty.assertIsDisplayed()
        val before = empty.getUnclippedBoundsInRoot()
        refreshFailure.assertDoesNotExist()
        syncBar.assertDoesNotExist()

        app.fixture.indicators = { MockResponse().setResponseCode(400) }
        mainLooper.idleFor(6, TimeUnit.SECONDS)
        val message = compose.activity.getString(R.string.chat_refresh_failed)
        compose.waitUntilExactlyOneExists(hasText(message), 10_000)
        assertEquals(before, empty.getUnclippedBoundsInRoot())
        val feedback = compose.onNodeWithTag("chat_list_feedback").getUnclippedBoundsInRoot()
        assertTrue(
            refreshFailure.getUnclippedBoundsInRoot().top > empty.getUnclippedBoundsInRoot().bottom,
        )
        assertTrue(feedback.top > empty.getUnclippedBoundsInRoot().bottom)
        compose.onNodeWithText("Back to Inbox").performClick()
        compose.waitUntilDoesNotExist(hasText(message), 10_000)
        compose.onNodeWithText("Personal chat").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun definitiveInitialUnreadFailureReplacesTheSkeletonInPlace() {
        val app = compose.activity.application as ChatListApplication
        val firstRead = CountDownLatch(1)
        app.fixture.indicators = {
            firstRead.await()
            MockResponse().setResponseCode(400)
        }
        val loadFailure = "Temporarily unable to load"
        val filter = compose.onNodeWithContentDescription("Filter")
        try {
            app.responseGate.countDown()
            compose.waitUntil(10_000) { currentList()?.confirmedAt != null }
            compose.onNodeWithText("Personal chat").assertIsDisplayed()
            filter.performClick()
            compose.onNodeWithText("Unread").performClick()
            val loading = compose.activity.getString(R.string.chat_loading)
            compose.waitUntilExactlyOneExists(hasContentDescription(loading), 10_000)
            compose.onNodeWithText(loadFailure).assertDoesNotExist()
            val toolbarBounds = filter.getUnclippedBoundsInRoot()
            val heading = compose.onNodeWithTag("chat_filter_heading").getUnclippedBoundsInRoot()

            firstRead.countDown()
            awaitListAndNames()
            val status = compose.onNodeWithText(loadFailure)
            val illustration = compose.onNodeWithTag("content-read-failure-illustration")
            status.assertIsDisplayed()
            illustration.assertIsDisplayed().assertWidthIsEqualTo(160.dp)
            compose.onNodeWithContentDescription(loading).assertDoesNotExist()
            compose.onNodeWithText("No unread chats").assertDoesNotExist()
            compose.onNodeWithText("Try again").assertDoesNotExist()
            compose.onNodeWithText(app.getString(R.string.chat_refresh_failed)).assertDoesNotExist()
            val statusBounds = status.getUnclippedBoundsInRoot()
            val illustrationBounds = illustration.getUnclippedBoundsInRoot()
            assertTrue(illustrationBounds.top > heading.bottom)
            assertEquals(16.dp, statusBounds.top - illustrationBounds.bottom)
            val listBounds = compose.onNodeWithTag("chat_list").getUnclippedBoundsInRoot()
            val listCenter = (listBounds.left + listBounds.right) / 2
            val statusCenter = (statusBounds.left + statusBounds.right) / 2
            assertTrue(kotlin.math.abs((listCenter - statusCenter).value) <= 1f)
            assertEquals(
                LiveRegionMode.Polite,
                status.fetchSemanticsNode().config[SemanticsProperties.LiveRegion],
            )
            val statusLayouts = mutableListOf<TextLayoutResult>()
            status.performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
                it(statusLayouts)
            }
            val style = statusLayouts.single().layoutInput.style
            assertEquals(16.sp, style.fontSize)
            assertEquals(24.sp, style.lineHeight)
            assertEquals(FontWeight.Medium, style.fontWeight)
            assertEquals(toolbarBounds, filter.getUnclippedBoundsInRoot())
        } finally {
            firstRead.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun aProjectRefreshFailureOverlaysTheListWithoutMovingItsScrollAnchor() {
        val app = compose.activity.application as ChatListApplication
        val rows =
            (1..22).joinToString(",") { index ->
                val suffix = index.toString().padStart(12, '0')
                chatEventWire(
                    id = "67000000-0000-4000-8000-$suffix",
                    seq = index.toLong(),
                    thread = "68000000-0000-4000-8000-$suffix",
                    title = "Inbox row $index",
                )
            }
        app.fixture.events = { request ->
            val events = if (request.requestUrl?.queryParameter("sinceSeqId") == null) rows else ""
            jsonResponse("""{"events":[$events],"hasMore":false}""")
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val list = compose.onNodeWithTag("chat_list")
        list.performScrollToNode(hasText("Inbox row 12"))
        val row = compose.onNodeWithText("Inbox row 12")
        val before = row.getUnclippedBoundsInRoot()
        val healthyProjects = app.fixture.projectEvents
        app.fixture.projectEvents = { MockResponse().setResponseCode(400) }
        refreshWorkspaceChats()
        val message = "Project information is temporarily unavailable."
        compose.waitUntilExactlyOneExists(hasText(message), 10_000)
        compose.onNodeWithText(message).assertIsDisplayed()
        assertEquals(before, row.getUnclippedBoundsInRoot())
        compose.onNodeWithTag("chat_list_feedback").assertIsDisplayed()

        app.fixture.projectEvents = healthyProjects
        refreshWorkspaceChats()
        compose.waitUntilDoesNotExist(hasText(message), 10_000)
        assertEquals(before, row.getUnclippedBoundsInRoot())
    }

    @Test
    @Config(qualifiers = "en-rUS-w320dp-h270dp")
    fun aShortPaneScrollsNewChatWithTheRows() {
        val app = compose.activity.application as ChatListApplication
        val rows =
            (1..14).joinToString(",") { index ->
                val suffix = index.toString().padStart(12, '0')
                chatEventWire(
                    id = "61000000-0000-4000-8000-$suffix",
                    seq = index.toLong(),
                    thread = "62000000-0000-4000-8000-$suffix",
                    title = "Short pane chat $index",
                )
            }
        app.fixture.events = { request ->
            val events = if (request.requestUrl?.queryParameter("sinceSeqId") == null) rows else ""
            jsonResponse("""{"events":[$events],"hasMore":false}""")
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("New chat").assertIsDisplayed()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Short pane chat 1"))
        compose.onNodeWithText("Short pane chat 1").assertIsDisplayed()
        compose.onNodeWithText("New chat").assertDoesNotExist()
        compose.onNodeWithTag("chat_list").performScrollToIndex(0)
        compose.onNodeWithText("New chat").assertIsDisplayed()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = ChatListApplication::class)
internal class ChatConversationLinkRootTest : ChatListRootTestFixture() {
    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun unavailableLinkTemporarilyReplacesConversationUndo() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.historyReply =
            "[Unavailable conversation](/chats/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)"
        val events = app.fixture.rowEventTail()
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath != "/api/chat-threads/$CHAT_PERSONAL/archive") null
            else {
                events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                MockResponse().setResponseCode(204)
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performClick()
        awaitInlineLink("Unavailable conversation")
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Archive chat").performClick()
        val feedback = hasAnyAncestor(hasTestTag("conversation_feedback"))
        val undo = hasText("Undo") and feedback
        compose.waitUntilExactlyOneExists(undo and isEnabled(), 10_000)

        compose.onNodeWithText("Unavailable conversation", substring = true).performFirstLinkClick()
        val unavailable = hasText("This conversation link is unavailable") and feedback
        compose.waitUntilExactlyOneExists(unavailable, 10_000)
        compose.onNode(unavailable).assertIsDisplayed()
        compose.onNode(undo).assertDoesNotExist()
        compose.mainClock.advanceTimeBy(FEEDBACK_TIMEOUT_MILLIS)
        compose.onNode(undo and isEnabled()).assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w960dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun messageLinkOpensTheNativeReadingTargetAndReturnsToTheSourceDraft() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        app.fixture.historyReply =
            "Read [Project update](/chats/$CHAT_IN_PROJECT#event-output).\n\n" +
                "[Unavailable conversation](/chats/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)"
        // Keep background warming from supplying the target before the held read.
        app.fixture.historyCatchUp = { jsonResponse("""{"events":{},"notFoundThreads":[]}""") }
        val destinationRequested = CountDownLatch(1)
        val destinationResponse = CountDownLatch(1)
        val historyRows = app.fixture.historyRows
        app.fixture.historyRows = { request ->
            if (request.requestUrl?.pathSegments?.getOrNull(2) == CHAT_IN_PROJECT) {
                destinationRequested.countDown()
                destinationResponse.await()
            }
            historyRows(request)
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            compose.onNodeWithText("Personal chat").performClick()
            val source = compose.onNodeWithText("Read ", substring = true)
            val link = awaitInlineLink("Project update")
            val editor = compose.onNode(hasTestTag("message_input") and hasSetTextAction())
            editor.performTextInput("Source draft")
            val sourceBounds = source.getUnclippedBoundsInRoot()
            link.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
            link.performKeyInput { pressKey(Key.Enter) }
            val destination = hasText("Project chat") and !hasAnyAncestor(hasTestTag("chat_list"))
            compose.waitUntilExactlyOneExists(destination, 10_000)
            compose.waitUntil(10_000) { destinationRequested.count == 0L }
            compose.onNodeWithTag("conversation_find_hit").assertDoesNotExist()

            compose.activityRule.scenario.recreate()
            compose.waitUntilExactlyOneExists(destination, 10_000)
            destinationResponse.countDown()
            compose.waitUntilExactlyOneExists(hasTestTag("conversation_find_hit"), 10_000)
            compose.onNodeWithTag("chat_list").assertIsDisplayed()
            editor.assert(hasText("Source draft").not())

            compose.onNodeWithContentDescription("Back").performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Source draft").fetchSemanticsNodes().isNotEmpty()
            }
            source.assertIsDisplayed()
            assertEquals(sourceBounds, source.getUnclippedBoundsInRoot())
            link.assertIsFocused()
            awaitInlineLink("Unavailable conversation")
            compose
                .onNodeWithText("Unavailable conversation", substring = true)
                .performFirstLinkClick()
            compose.onNodeWithText("This conversation link is unavailable").assertIsDisplayed()
            editor.assertTextContains("Source draft")
        } finally {
            destinationResponse.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w960dp-h800dp")
    fun linkedConversationReturnsToSourceWhenTheDestinationIsDeletedElsewhere() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.historyReply = "[Project update](/chats/$CHAT_IN_PROJECT)"
        val remoteEvents = app.fixture.rowEventTail()
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        awaitInlineLink("Project update")
        val editor = compose.onNode(hasTestTag("message_input") and hasSetTextAction())
        editor.performTextInput("Source draft")
        compose.onNodeWithText("Project update", substring = true).performFirstLinkClick()
        val detailTitle = !hasAnyAncestor(hasTestTag("chat_list"))
        compose.waitUntilExactlyOneExists(hasText("Project chat") and detailTitle, 10_000)

        remoteEvents.add(
            24L to chatEventWire(UUID.randomUUID().toString(), 24, CHAT_IN_PROJECT, "deleted"),
        )
        refreshWorkspaceChats()
        compose.waitUntil(10_000) {
            currentList()?.threads?.none { it.id == CHAT_IN_PROJECT } == true
        }
        compose.waitUntilExactlyOneExists(hasText("This conversation link is unavailable"), 10_000)
        compose.onNode(hasText("Personal chat") and detailTitle).assertIsDisplayed()
        editor.assertTextContains("Source draft")
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun messageLinkUsesCachedHistoryWhenTheRequestFails() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.historyReply = "[Project update](/chats/$CHAT_IN_PROJECT#event-output)"
        app.fixture.historyCatchUp = { jsonResponse("""{"events":{},"notFoundThreads":[]}""") }
        val historyRows = app.fixture.historyRows
        val historyUnavailable = AtomicBoolean(false)
        app.fixture.historyRows = { request ->
            if (
                historyUnavailable.get() &&
                    request.requestUrl?.pathSegments?.getOrNull(2) == CHAT_IN_PROJECT
            )
                MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
            else historyRows(request)
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        awaitInlineLink("Project update")
        val link = compose.onNodeWithText("Project update", substring = true)
        val hit = hasTestTag("conversation_find_hit")
        val unavailable = hasText("This conversation link is unavailable")

        link.performFirstLinkClick()
        compose.waitUntilExactlyOneExists(hit, 10_000)
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("Personal chat").assertIsDisplayed()
        awaitInlineLink("Project update")

        historyUnavailable.set(true)
        link.performFirstLinkClick()
        compose.waitUntilExactlyOneExists(hit, 10_000)
        compose.onNodeWithText("Project chat").assertIsDisplayed()
        compose.onNode(unavailable).assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun returningThroughAnInlineLinkPreservesTheWorkspaceSearch() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.historyReply = "[Project update](/chats/$CHAT_IN_PROJECT)"
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        val query = compose.onNodeWithTag("chat_search_query")
        query.performTextInput("personal")
        compose.waitUntilExactlyOneExists(hasText("Personal chat"), 10_000)
        compose.onNodeWithText("Personal chat").performClick()
        val link = hasText("Project update", substring = true)
        awaitInlineLink("Project update")
        compose.onNode(link).performFirstLinkClick()
        compose.waitUntilExactlyOneExists(hasText("Project chat"), 10_000)

        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitUntilExactlyOneExists(link, 10_000)
        compose.onNodeWithText("Personal chat").assertIsDisplayed()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        query.assertIsDisplayed().assertTextContains("personal")
        compose.onNodeWithText("Personal chat").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w960dp-h800dp")
    fun systemBackRespectsTheOrderOfWideSearchAndConversationLinks() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.historyReply = "[Project update](/chats/$CHAT_IN_PROJECT)"
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        awaitInlineLink("Project update")
        compose.onNodeWithContentDescription("Search workspace").performClick()
        val query = compose.onNodeWithTag("chat_search_query")
        query.performTextInput("personal")
        val detail = !hasAnyAncestor(hasTestTag("chat_list") or hasTestTag("chat_search"))
        val source = compose.onNode(hasText("Personal chat") and detail)
        val destination = compose.onNode(hasText("Project chat") and detail)
        source.assertIsDisplayed()
        val link = compose.onNodeWithText("Project update", substring = true)
        link.performFirstLinkClick()
        destination.assertIsDisplayed()
        query.assertTextContains("personal")

        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }

        source.assertIsDisplayed()
        query.assertIsDisplayed().assertTextContains("personal")
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        query.assertDoesNotExist()
        source.assertIsDisplayed()

        awaitInlineLink("Project update")
        link.performFirstLinkClick()
        destination.assertIsDisplayed()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        query.performTextInput("project")
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        query.assertDoesNotExist()
        destination.assertIsDisplayed()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        source.assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun webpageLinksOpenFromParagraphsAndQuotedTablesWithoutLeavingTheConversation() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.historyReply =
            """
            Read [Release notes](https://example.org/releases?version=2).

            > | Check | Result |
            > | --- | --- |
            > | Build | [Build details](https://example.org/build/42) |
            """
                .trimIndent()
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        awaitInlineLink("Release notes")
        val text = compose.onNodeWithText("Release notes", substring = true)
        val layouts = mutableListOf<TextLayoutResult>()
        text.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val layout = layouts.single().layoutInput
        assertEquals(16.sp, layout.style.fontSize)
        assertEquals(28.sp, layout.style.lineHeight)
        val linkStyle =
            checkNotNull(
                layout.text.getLinkAnnotations(0, layout.text.length).single().item.styles?.style,
            )
        assertEquals(FontWeight.SemiBold, linkStyle.fontWeight)
        assertEquals(TextDecoration.Underline, linkStyle.textDecoration)
        text.performFirstLinkClick()
        val intent = shadowOf(compose.activity).nextStartedActivity
        assertEquals(android.content.Intent.ACTION_VIEW, intent.action)
        assertEquals("https://example.org/releases?version=2", intent.dataString)
        text.assertIsDisplayed()

        awaitInlineLink("Build details")
        val quoted = compose.onNodeWithText("Build details", substring = true)
        quoted.performFirstLinkClick()
        val quotedIntent = shadowOf(compose.activity).nextStartedActivity
        assertEquals(android.content.Intent.ACTION_VIEW, quotedIntent.action)
        assertEquals("https://example.org/build/42", quotedIntent.dataString)
        quoted.assertIsDisplayed()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = ChatListApplication::class)
internal class ChatSearchRootTest : ChatListRootTestFixture() {
    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun titleSearchRestoresTheQueryAfterOpeningAnArchivedChatAndRecreating() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.events = { request ->
            if (request.requestUrl?.queryParameter("sinceSeqId") != null) {
                jsonResponse("""{"events":[],"hasMore":false}""")
            } else {
                val project =
                    chatEventWire(
                        id = "77777777-7777-4777-8777-777777777777",
                        seq = 23,
                        thread = CHAT_IN_PROJECT,
                        extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                        title = "Project chat",
                    )
                val archived =
                    chatEventWire(
                        id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        seq = 24,
                        thread = CHAT_IN_PROJECT,
                        kind = "archived",
                    )
                jsonResponse(
                    """{"events":[${chatEventWire()},$project,$archived],"hasMore":false}""",
                )
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val entry = compose.onNodeWithTag("workspace_search_entry")
        val logo = compose.onNodeWithTag("workspace_search_leading")
        val initialBounds = entry.getUnclippedBoundsInRoot()
        assertEquals(8.dp, initialBounds.left - logo.getUnclippedBoundsInRoot().right)
        val filter = compose.onNodeWithContentDescription("Filter")
        assertEquals(8.dp, filter.getUnclippedBoundsInRoot().left - initialBounds.right)
        entry.performClick()
        val query = compose.onNodeWithTag("chat_search_query")
        query.assert(hasContentDescription("Search workspace"))
        val inputBounds = query.getUnclippedBoundsInRoot()
        val allResults = compose.onNodeWithTag("search_type_All").getUnclippedBoundsInRoot()
        assertEquals(initialBounds.left, inputBounds.left)
        assertEquals(initialBounds.top, inputBounds.top)
        assertEquals(initialBounds.bottom, inputBounds.bottom)
        assertEquals(8.dp, allResults.top - inputBounds.bottom)
        compose.onNodeWithText("Recent chats").assertExists()
        query.performTextInput("project")
        query.performTextInputSelection(TextRange(3))
        compose.onNodeWithText("Personal chat").assertDoesNotExist()
        compose.onNodeWithText("Research · Archived").assertExists()
        compose.onNodeWithText("Project chat").performClick()
        compose.onNodeWithTag("conversation").assertExists()

        compose.activityRule.scenario.recreate()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }

        compose
            .onNodeWithTag("chat_search_query")
            .assert(hasText("project"))
            .assert(
                SemanticsMatcher.expectValue(SemanticsProperties.TextSelectionRange, TextRange(3)),
            )
        compose.onNodeWithText("Project chat").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("chat_list").assertExists()
        entry.assertIsFocused()
        compose.onNodeWithText("Project chat").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h460dp")
    fun returningToRecentSearchFocusesTheOpenedChatAfterItMovesUp() {
        val app = compose.activity.application as ChatListApplication
        val threads = List(8) { UUID.randomUUID().toString() }
        val events = threads.mapIndexed { index, id ->
            chatEventWire(
                id = UUID.randomUUID().toString(),
                seq = 17L + index,
                thread = id,
                title = "Visit $index",
            )
        }
        app.fixture.historyThreadIds = threads.toSet()
        app.fixture.events = { request ->
            val rows =
                if (request.requestUrl?.queryParameter("sinceSeqId") == null) events
                else emptyList()
            jsonResponse("""{"events":[${rows.joinToString(",")}],"hasMore":false}""")
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val ready = compose.runOnIdle {
            checkNotNull(
                ViewModelProvider(compose.activity)[SessionModel::class.java].uiState.value.ready,
            )
        }
        runBlocking { threads.forEach { app.searchRecents.record(ready.identity, it) } }

        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.waitUntilExactlyOneExists(hasText("Recently opened"), 5_000)
        compose.onNodeWithTag("chat_search_results").performScrollToNode(hasText("Visit 0"))
        compose.onNodeWithText("Visit 0").performClick()
        compose.onNodeWithTag("conversation").assertIsDisplayed()
        compose.waitUntil(5_000) {
            compose.runOnIdle { ready.search.recentlyOpened.value.firstOrNull() == threads.first() }
        }
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }

        compose.waitUntilExactlyOneExists(hasText("Visit 0") and isFocused(), 5_000)
        compose.onNodeWithText("Visit 0").assertIsDisplayed().assertIsFocused()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun pastedTitleRetainsItsUnicodeAndMatchesTheWholeQuery() {
        val app = compose.activity.application as ChatListApplication
        val prefix = "a".repeat(255)
        val title = "$prefix🧪 release"
        val other = "$prefix🔔 release"
        app.fixture.events = { request ->
            if (request.requestUrl?.queryParameter("sinceSeqId") != null) {
                jsonResponse("""{"events":[],"hasMore":false}""")
            } else {
                val project =
                    chatEventWire(
                        id = "77777777-7777-4777-8777-777777777777",
                        seq = 23,
                        thread = CHAT_IN_PROJECT,
                        extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                        title = other,
                    )
                jsonResponse(
                    """{"events":[${chatEventWire(title = title)},$project],"hasMore":false}""",
                )
            }
        }
        app.responseGate.countDown()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(title).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput(title)
        compose.onNodeWithTag("chat_search_query").assert(hasText(title))
        compose.onNodeWithTag("chat_search_results").performScrollToNode(hasText(title))
        compose.onNodeWithText(other).assertDoesNotExist()
        compose
            .onNode(hasText(title) and hasAnyAncestor(hasTestTag("chat_search_results")))
            .performClick()
        compose.onNodeWithTag("conversation").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("chat_search_query").assert(hasText(title))
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun titleSearchKeepsTheResultAndOverlaysARefreshFailureUntilRecovery() {
        val app = compose.activity.application as ChatListApplication
        val realtime = app.realtimeService as TestRealtimeService
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("search_type_Chats").performClick()
        val input = compose.onNodeWithTag("chat_search_query")
        input.performClick()
        input.performTextInput("personal")
        val result = compose.onNodeWithText("Personal chat")
        val resultBounds = result.getUnclippedBoundsInRoot()
        val events = app.fixture.events
        app.fixture.events = { MockResponse().setResponseCode(400) }
        realtime.invalidate(ChatChanges(list = true))

        val notice = hasText(app.getString(R.string.chat_search_saved_chats))
        compose.waitUntilExactlyOneExists(notice, 5_000)
        result.assertIsDisplayed()
        assertTrue(compose.onNode(notice).getUnclippedBoundsInRoot().top >= resultBounds.bottom)
        assertEquals(resultBounds, result.getUnclippedBoundsInRoot())
        compose.onNodeWithText(app.getString(R.string.retry)).assertDoesNotExist()
        input.assertIsFocused().assert(hasText("personal"))
        app.fixture.events = events
        realtime.invalidate(ChatChanges(list = true))
        compose.waitUntilDoesNotExist(notice, 5_000)
        assertEquals(resultBounds, result.getUnclippedBoundsInRoot())
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    fun wideTitleSearchReturnsTheListAndOpensTheResultInDetail() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("conversation").assertExists()
        compose.onNodeWithText("Chats").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput("missing")
        compose.onNodeWithText("No matching chats").assertExists()
        compose.onNodeWithText("Search all types").performClick()
        compose.onNodeWithText("All").assertIsSelected()
        compose.onNodeWithTag("chat_search_query").assert(hasText("missing"))
        compose.onNodeWithContentDescription("Clear search").performClick()
        compose.onNodeWithTag("chat_search_query").assertIsFocused().performTextInput("CHAT")
        val results = hasAnyAncestor(hasTestTag("chat_search_results"))
        val project = compose.onNode(hasText("Project chat") and results)
        val personal = compose.onNode(hasText("Personal chat") and results)
        assertTrue(
            project.fetchSemanticsNode().boundsInRoot.top <
                personal.fetchSemanticsNode().boundsInRoot.top,
        )
        project.performClick()
        compose.onNodeWithTag("chat_search").assertDoesNotExist()
        compose.onNodeWithTag("chat_list").assertExists()
        compose.onNodeWithTag("conversation").assertExists()
        compose.onNodeWithTag("chat_$CHAT_IN_PROJECT").assertDoesNotExist()
        setResearchExpanded(true)
        compose.onNodeWithTag("chat_$CHAT_IN_PROJECT").assertIsSelected()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun workspaceMessageSearchRestoresItsTypeAndOpensTheExactEvent() {
        val app = compose.activity.application as ChatListApplication
        val body =
            "See the [documentation](https://example.org/history).\n\n**Native history** reply"
        val linkMatch = body.indexOf("history")
        val replyMatch = body.lastIndexOf("history")
        app.fixture.historyReply = body
        app.fixture.searchMessages = { request ->
            assertEquals("history", request.requestUrl?.queryParameter("keyword"))
            assertEquals("Bearer fixture-token", request.getHeader("Authorization"))
            jsonResponse(
                """
                {"results":[{"chatThreadId":"$CHAT_PERSONAL","agentName":"Okou",
                  "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                    "content":${JsonPrimitive(body)},"createdAt":"$CHAT_DATE","seqId":23,"runId":"$HISTORY_RUN"},
                  "matchedRanges":[
                    {"start":$linkMatch,"end":${linkMatch + "history".length}},
                    {"start":$replyMatch,"end":${replyMatch + "history".length}}]}]}
                """,
            )
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithText("Messages").performClick()
        val field = compose.onNodeWithTag("chat_search_query")
        field.performTextInput("history")
        val match =
            hasText("Native history reply") and hasAnyAncestor(hasTestTag("chat_search_results"))
        compose.waitUntilExactlyOneExists(match, 5_000)
        compose.onNode(match).performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("message_output"), 5_000)
        compose.onNodeWithTag("message_output").assertIsDisplayed()
        compose.waitUntilExactlyOneExists(hasTestTag("conversation_find_hit"), 5_000)
        compose
            .onNodeWithTag("conversation_find_hit")
            .assertIsFocused()
            .assertTextEquals("Native history reply")
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        compose.onNodeWithTag("conversation_find").assertIsDisplayed()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithTag("conversation").assertIsDisplayed()
        compose.onNodeWithTag("conversation_find_hit").assertDoesNotExist()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        field.assert(hasText("history"))
        compose.onNode(hasText("Messages") and isSelectable()).assertIsSelected()
        compose.onNode(match).assertIsDisplayed()
        compose.onNodeWithContentDescription("Clear search").performClick()
        field.assertIsFocused()
        compose.onNode(hasText("Messages") and isSelectable()).assertIsSelected()
        compose.onNodeWithText("Enter a keyword to search").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun workspaceMessageSearchKeepsUserDisplayTextLiteral() {
        val app = compose.activity.application as ChatListApplication
        val prompt = "Please find **release** notes."
        val start = prompt.indexOf("release")
        app.fixture.searchMessages = { request ->
            assertEquals("release", request.requestUrl?.queryParameter("keyword"))
            jsonResponse(
                """
                {"results":[{"chatThreadId":"$CHAT_PERSONAL",
                  "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"user",
                    "content":${JsonPrimitive(prompt)},"createdAt":"$CHAT_DATE","seqId":22,"runId":"$HISTORY_RUN"},
                  "matchedRanges":[{"start":$start,"end":${start + "release".length}}]}]}
                """,
            )
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("search_type_Messages").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput("release")
        val result = hasText(prompt) and hasAnyAncestor(hasTestTag("chat_search_results"))
        compose.waitUntilExactlyOneExists(result, 5_000)
        compose.onNode(result).assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w960dp-h800dp")
    fun workspaceMessageSearchRevealsOnlyTheMatchedFoldedTurnInTheDetailPane() {
        val app = compose.activity.application as ChatListApplication
        val fixture = FoldedWorkspaceSearchFixture(app.fixture)
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performClick()

        val summary = hasTestTag("conversation_reply_summary")
        val matchedSummary =
            summary and hasAnyAncestor(hasTestTag("message_${fixture.matchedFinalId}"))
        val otherSummary = summary and hasAnyAncestor(hasTestTag("message_${fixture.otherFinalId}"))
        fun disclosure(@androidx.annotation.StringRes id: Int) =
            SemanticsMatcher("reply disclosure matches") { node ->
                node.config
                    .getOrNull(SemanticsProperties.StateDescription)
                    ?.endsWith(compose.activity.getString(id)) == true
            }
        val collapsed = disclosure(R.string.conversation_replies_collapsed)
        val expanded = disclosure(R.string.conversation_replies_expanded)
        compose.waitUntil(5_000) {
            compose.onAllNodes(otherSummary, useUnmergedTree = true).fetchSemanticsNodes().size == 1
        }
        compose.onNode(matchedSummary, useUnmergedTree = true).assert(collapsed)
        compose.onNode(otherSummary, useUnmergedTree = true).assert(collapsed)

        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("search_type_Messages").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput(fixture.keyword)
        val results = hasAnyAncestor(hasTestTag("chat_search_results"))
        val result = hasText(fixture.hit, substring = true) and results
        compose.waitUntilExactlyOneExists(result, 5_000)
        compose.onNode(hasText(fixture.otherHit) and results).assertIsDisplayed()
        val row = compose.onNode(result)
        val preview = row.fetchSemanticsNode().config[SemanticsProperties.Text]
        val snippet = preview.single { it.text == fixture.hit }
        val expectedMatches =
            Regex.fromLiteral(fixture.keyword).findAll(fixture.hit).map { it.range }
        assertEquals(expectedMatches.toList(), snippet.spanStyles.map { it.start until it.end })
        row.performClick()

        val focused = hasTestTag("conversation_find_hit") and isFocused()
        compose.waitUntilExactlyOneExists(focused, 5_000)
        compose.onNode(focused).assertIsDisplayed().assertTextEquals(fixture.hit)
        compose.onNodeWithText(fixture.leadingParagraph).assertIsDisplayed()
        compose.onNode(matchedSummary, useUnmergedTree = true).assert(expanded)
        compose.onNode(otherSummary, useUnmergedTree = true).assert(collapsed)
        compose.onNodeWithText(fixture.otherEarlierReply).assertDoesNotExist()
        compose.onNodeWithTag("chat_search").assertDoesNotExist()
        val list = compose.onNodeWithTag("chat_list").getUnclippedBoundsInRoot()
        assertTrue(compose.onNode(focused).getUnclippedBoundsInRoot().left > list.right)
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").assertIsSelected()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun workspaceMessageSearchRevealsTheMatchedCellOutsideTheHorizontalViewport() {
        val app = compose.activity.application as ChatListApplication
        val query = "approval"
        val text = "Launch approval"
        val body =
            "| Phase | Build | Tests | Assets | Owner |\n" +
                "| --- | --- | --- | --- | --- |\n" +
                "| Release | Ready | Passed | Ready | $text |"
        val start = body.indexOf(query)
        app.fixture.historyReply = body
        app.fixture.searchMessages = { request ->
            assertEquals(query, request.requestUrl?.queryParameter("keyword"))
            jsonResponse(
                """
                {"results":[{"chatThreadId":"$CHAT_PERSONAL",
                  "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                    "content":${JsonPrimitive(body)},"createdAt":"$CHAT_DATE","seqId":23,"runId":"$HISTORY_RUN"},
                  "matchedRanges":[{"start":$start,"end":${start + query.length}}]}]}
                """,
            )
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("search_type_Messages").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput(query)
        val result =
            hasText(text, substring = true) and hasAnyAncestor(hasTestTag("chat_search_results"))
        compose.waitUntilExactlyOneExists(result, 5_000)
        compose.onNode(result).performClick()

        val focused = hasTestTag("conversation_find_hit") and isFocused() and hasText(text)
        compose.waitUntilExactlyOneExists(focused, 5_000)
        val cell = compose.onNode(focused).assertIsDisplayed().assertTextEquals(text)
        val bounds = cell.getUnclippedBoundsInRoot()
        val conversation = compose.onNodeWithTag("conversation").getUnclippedBoundsInRoot()
        assertEquals(112.dp, bounds.right - bounds.left)
        assertTrue(bounds.right <= conversation.right - 24.dp)
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun workspaceMessageSearchReportsMissingChatListAndShowsTheHitAfterRefresh() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val chatEvents = fixture.events
        fixture.events = { MockResponse().setResponseCode(400) }
        fixture.searchMessages = {
            jsonResponse(
                """
                {"results":[{"chatThreadId":"$CHAT_PERSONAL","agentName":"Okou",
                  "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                    "content":"Native history reply","createdAt":"$CHAT_DATE","seqId":23,"runId":"$HISTORY_RUN"},
                  "matchedRanges":[{"start":7,"end":14}]}]}
                """,
            )
        }
        app.responseGate.countDown()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("search_type_Messages").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput("history")

        val results = hasAnyAncestor(hasTestTag("chat_search_results"))
        val unavailable = hasText(app.getString(R.string.chat_list_first_load_failed)) and results
        compose.waitUntilExactlyOneExists(unavailable, 5_000)
        compose.onNodeWithText("No matching messages").assertDoesNotExist()

        val retry = hasText(app.getString(R.string.retry)) and results
        compose.onNode(retry).assertDoesNotExist()
        val readStarted = CountDownLatch(1)
        val finishRead = CountDownLatch(1)
        fixture.events = { request ->
            readStarted.countDown()
            finishRead.await()
            chatEvents(request)
        }
        try {
            refreshWorkspaceChats()
            compose.waitUntil(5_000) { readStarted.count == 0L }
            compose.onNode(retry).assertDoesNotExist()
        } finally {
            finishRead.countDown()
        }
        val hit = hasText("Native history reply") and results
        compose.waitUntilExactlyOneExists(hit, 5_000)
        compose.onNode(hit).assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun workspaceMessageSearchCatchesUpAnAlreadyOpenHistoryBeforeRevealingTheHit() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        fixture.historyReply =
            List(40) { "Cached history paragraph ${it + 1}" }.joinToString("\n\n")
        val text = "New search message"
        val eventId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        fixture.searchMessages = {
            jsonResponse(
                """
                {"results":[{"chatThreadId":"$CHAT_PERSONAL","agentName":"Okou",
                  "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                    "content":"$text","createdAt":"$CHAT_DATE","seqId":41,"runId":"$HISTORY_RUN"},
                  "matchedRanges":[{"start":4,"end":10}]}]}
                """,
            )
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val history = compose.runOnIdle {
            checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready,
                )
                .chats
                .history
        }
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performClick()
        compose.waitUntil(10_000) {
            compose.runOnIdle { history.uiState.value.phase == HistoryPhase.Ready }
        }

        val staleRead = CountDownLatch(1)
        val release = CountDownLatch(1)
        val oldRows = fixture.historyRows
        val nextReadIsStale = AtomicBoolean(true)
        val allowCatchUp = AtomicBoolean()
        fixture.historyRows = { request ->
            val url = checkNotNull(request.requestUrl)
            if (url.pathSegments[2] != CHAT_PERSONAL || url.queryParameter("sinceSeqId") != "37") {
                oldRows(request)
            } else if (nextReadIsStale.getAndSet(false)) {
                staleRead.countDown()
                release.await()
                oldRows(request)
            } else if (!allowCatchUp.get()) {
                MockResponse().setResponseCode(400)
            } else {
                val event =
                    historyEventWire(id = eventId, seq = 41, payload = """{"content":"$text"}""")
                jsonResponse(
                    """{"rows":[$event],"cursor":{"lastEventId":"$eventId","lastSeqId":41},"hasMore":false}""",
                )
            }
        }
        try {
            compose.runOnIdle { history.invalidate(CHAT_PERSONAL) }
            compose.waitUntil(10_000) { staleRead.count == 0L }
            compose.onNodeWithContentDescription("Search workspace").performClick()
            compose.onNodeWithTag("search_type_Messages").performClick()
            compose.onNodeWithTag("chat_search_query").performTextInput("search")
            val hit = hasText(text) and hasAnyAncestor(hasTestTag("chat_search_results"))
            compose.waitUntilExactlyOneExists(hit, 5_000)
            compose.onNode(hit).performClick()
            compose.onNodeWithTag("chat_search").assertDoesNotExist()
            release.countDown()

            compose.waitUntil(10_000) {
                compose.runOnIdle { history.uiState.value.phase == HistoryPhase.Failed }
            }
            compose.onNodeWithTag("conversation").performScrollToKey("input")
            compose.onNodeWithContentDescription("Back to latest").assertIsDisplayed()
            allowCatchUp.set(true)
            compose.runOnIdle { history.refresh() }
            compose.waitUntilExactlyOneExists(hasTestTag("conversation_find_hit"), 10_000)
            compose.onNodeWithTag("conversation_find_hit").assertIsFocused()
            compose.onNodeWithText(text).assertIsDisplayed()
            compose.onNodeWithTag("chat_$CHAT_PERSONAL").assertIsSelected()
        } finally {
            release.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w960dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun findInConversationRestoresQueryAndFocusAfterOpeningAFoldedReply() {
        val app = compose.activity.application as ChatListApplication
        val folded = "Folded staging instructions. Keep the folded staging checklist."
        app.fixture.historyCatchUp = { jsonResponse("""{"events":{},"notFoundThreads":[]}""") }
        app.fixture.historyRows = { request ->
            val thread = checkNotNull(request.requestUrl).pathSegments[2]
            val after = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
            val rows =
                listOf(
                        17L to
                            historyEventWire(
                                "input",
                                17,
                                thread,
                                "input.prompt",
                                """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Hello history"}]}}""",
                            ),
                        22L to
                            historyEventWire(
                                "earlier",
                                22,
                                thread,
                                payload =
                                    """{"content":"## Earlier draft\n\n$folded\n\nReview this after launch."}""",
                            ),
                        23L to historyEventWire("output", 23, thread),
                        37L to
                            historyEventWire(
                                HISTORY_LAST_EVENT,
                                37,
                                thread,
                                "run.completed",
                                "null",
                            ),
                    )
                    .filter { (seq, _) -> seq > after }
                    .joinToString(",") { it.second }
            jsonResponse(
                """{"rows":[$rows],"cursor":{"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":37},"hasMore":false}""",
            )
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Native history", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithText(folded).assertDoesNotExist()

        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        val query = compose.onNodeWithTag("conversation_find_query")
        query.assertIsFocused()
        val fieldBounds = query.getUnclippedBoundsInRoot()
        val listBounds = compose.onNodeWithTag("chat_list").getUnclippedBoundsInRoot()
        assertTrue(fieldBounds.bottom - fieldBounds.top >= 48.dp)
        assertTrue(fieldBounds.left > listBounds.right)
        val draftQuery = "  FOLDED   STAGING  "
        query.performTextInput(draftQuery)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("1 matching message").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(folded, substring = true).performClick()
        val hit = compose.onNodeWithTag("conversation_find_hit")
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasTestTag("conversation_find_hit"))
                .fetchSemanticsNodes()
                .firstOrNull()
                ?.config
                ?.getOrElse(SemanticsProperties.Focused) { false } == true
        }
        hit.assertIsDisplayed().assertIsFocused().assertTextContains(folded)
        compose.onNodeWithText("Earlier draft").assertExists()

        fun hitBackground(): Color {
            val pixels = hit.captureToImage().toPixelMap()
            return pixels[pixels.width / 2, 1]
        }
        val palette = resolvePalette(UserPreferencesColorTheme.DEFAULT, dark = false)
        val highlighted = palette.secondaryContainer
        val normal = palette.background
        val hitBounds = hit.getUnclippedBoundsInRoot()
        compose.mainClock.advanceTimeBy(1_000)
        assertEquals(highlighted, hitBackground())
        compose.mainClock.advanceTimeBy(1_048)
        assertEquals("The Find highlight should clear after two seconds", normal, hitBackground())
        hit.assertIsDisplayed().assertIsFocused()
        assertEquals(hitBounds, hit.getUnclippedBoundsInRoot())

        compose.onNodeWithContentDescription("Back").performClick()
        query.assertTextContains(draftQuery)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(folded, substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(folded, substring = true).assertIsFocused()
        compose.onNodeWithContentDescription("Clear search").performClick()
        query.assertIsFocused()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Browse turns").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Hello history").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back").performClick()
        hit.assertDoesNotExist()
        compose.onNodeWithTag("conversation").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w960dp-h800dp")
    fun findIncludesTheQueuedPromptOnlyAfterHistoryConfirmsDelivery() {
        val app = compose.activity.application as ChatListApplication
        val prompt = "Add the launch checklist"
        val payload = """{"userMessage":{"version":1,"parts":[{"type":"text","text":"$prompt"}]}}"""
        val queuedId = HISTORY_LAST_EVENT
        val deliveredId = "88888888-8888-4888-8888-888888888889"
        val queued =
            historyEventWire(queuedId, 37, CHAT_PERSONAL, "input.prompt", payload, run = null)
        val delivered =
            historyEventWire(
                deliveredId,
                38,
                CHAT_PERSONAL,
                "input.prompt",
                payload,
                revoke = queuedId,
            )
        val deliveryAvailable = AtomicBoolean(false)
        app.fixture.historyCatchUp = { jsonResponse("""{"events":{},"notFoundThreads":[]}""") }
        app.fixture.historyRows = { request ->
            val after = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
            val hasDelivery = deliveryAvailable.get()
            val rows =
                listOfNotNull(
                    queued.takeIf { after < 37 },
                    delivered.takeIf { hasDelivery && after < 38 },
                )
            val cursor = if (hasDelivery) deliveredId else queuedId
            val seq = if (hasDelivery) 38 else 37
            jsonResponse(
                """{"rows":[${rows.joinToString(",")}],"cursor":{"lastEventId":"$cursor","lastSeqId":$seq},"hasMore":false}""",
            )
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        val queue = hasTestTag("open_conversation_queue")
        compose.waitUntilExactlyOneExists(queue, 10_000)
        compose.onNodeWithText(prompt).assertDoesNotExist()
        compose.onNode(queue).performClick()
        val panel = hasTestTag("conversation_queue")
        compose.waitUntilExactlyOneExists(panel, 10_000)
        compose.onNode(hasText(prompt) and hasAnyAncestor(panel)).assertIsDisplayed()
        compose.onNode(hasContentDescription("Back") and hasAnyAncestor(isDialog())).performClick()

        fun findChecklist() {
            compose.onNodeWithContentDescription("Chat actions").performClick()
            compose.onNodeWithText("Find messages").performClick()
            compose.onNodeWithTag("conversation_find_query").performTextInput("launch checklist")
        }
        val noMatch = hasText("No matching messages")
        val oneMatch = hasText("1 matching message")
        findChecklist()
        compose.waitUntilExactlyOneExists(noMatch or oneMatch, 10_000)
        compose.onNode(noMatch).assertIsDisplayed()
        compose
            .onNode(
                hasContentDescription("Back") and hasAnyAncestor(hasTestTag("conversation_find")),
            )
            .performClick()

        deliveryAvailable.set(true)
        compose.runOnIdle {
            checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready,
                )
                .chats
                .history
                .invalidate(CHAT_PERSONAL)
        }
        compose.waitUntilExactlyOneExists(hasTestTag("message_$deliveredId"), 10_000)
        compose.onNode(queue).assertDoesNotExist()
        findChecklist()
        compose.waitUntilExactlyOneExists(oneMatch, 10_000)
        compose.onNodeWithText(prompt).assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w960dp-h800dp")
    fun openingFindFromTheHitRestoresTheResultsAndClosingItReturnsToTheKeyboardTrigger() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        compose.waitUntilExactlyOneExists(hasText("Native history reply"), 10_000)

        val actions = compose.onNodeWithContentDescription("Chat actions")
        actions.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        actions.performClick()
        compose.onNodeWithText("Find messages").performClick()
        val query = compose.onNodeWithTag("conversation_find_query")
        query.assertIsFocused().performTextInput("Native history")
        compose.waitUntilExactlyOneExists(hasText("1 matching message"), 10_000)
        val result = compose.onNodeWithText("Native history reply")
        result.performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("conversation_find_hit"), 10_000)

        actions.performClick()
        compose.onNodeWithText("Find messages").performClick()
        query.assertTextContains("Native history")
        compose.waitUntilExactlyOneExists(hasText("1 matching message"), 10_000)
        result.assertIsFocused()

        compose.onNodeWithContentDescription("Back").performClick()
        actions.assertIsFocused()
    }

    @Test
    @Config(qualifiers = "en-rUS-w960dp-h800dp")
    fun findAndWorkspaceSearchKeepTheirOwnBackAndFocus() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        compose.waitUntilExactlyOneExists(hasText("Native history reply"), 10_000)
        fun openFind() {
            compose.onNodeWithContentDescription("Chat actions").performClick()
            compose.onNodeWithText("Find messages").performClick()
        }

        val workspaceSearch = compose.onNodeWithTag("chat_search")
        val workspaceEntry = compose.onNodeWithContentDescription("Search workspace")
        val workspaceQuery = compose.onNodeWithTag("chat_search_query")
        val query = compose.onNodeWithTag("conversation_find_query")
        workspaceEntry.performClick()
        openFind()
        query.assertIsFocused()
        compose
            .onNode(
                hasContentDescription("Back") and hasAnyAncestor(hasTestTag("conversation_find")),
            )
            .performClick()
        query.assertDoesNotExist()
        workspaceSearch.assertIsDisplayed()
        workspaceQuery.performTouchInput { click() }.assertIsFocused()

        openFind()
        query.performTextInput("Native history")
        compose.waitUntilExactlyOneExists(hasText("1 matching message"), 10_000)
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        workspaceSearch.assertDoesNotExist()
        query.assertIsDisplayed().assertTextContains("Native history")

        compose.onNodeWithText("Native history reply").performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("conversation_find_hit"), 10_000)
        workspaceEntry.performClick()
        val workspaceSearchAncestor = hasAnyAncestor(hasTestTag("chat_search"))
        val hitBack = compose.onNode(hasContentDescription("Back") and !workspaceSearchAncestor)
        workspaceQuery.assertIsFocused()
        // Deliver the tap without advancing a frame for the returned Find results.
        compose.mainClock.autoAdvance = false
        try {
            hitBack.performClick()
            workspaceQuery.assert(!isFocused())
            workspaceQuery
                .performTouchInput {
                    down(center)
                    up()
                }
                .assertIsFocused()
        } finally {
            compose.mainClock.autoAdvance = true
        }
        compose.waitUntilExactlyOneExists(hasText("1 matching message"), 10_000)
        workspaceSearch.assertIsDisplayed()
        query.assertIsDisplayed().assertTextContains("Native history")

        workspaceQuery.assertIsFocused().performTextInput("project")
        val rows = app.fixture.historyRows
        app.fixture.historyRows = { request ->
            if (request.requestUrl?.pathSegments?.getOrNull(2) == CHAT_PERSONAL)
                MockResponse().setResponseCode(403)
            else rows(request)
        }
        compose.runOnIdle {
            checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready,
                )
                .chats
                .history
                .invalidate(CHAT_PERSONAL)
        }
        compose.waitUntilExactlyOneExists(hasText(app.getString(R.string.history_missing)), 10_000)
        query.assertDoesNotExist()
        workspaceQuery.assertIsFocused().assertTextContains("project")
        compose.onNode(hasContentDescription("Back") and workspaceSearchAncestor).performClick()
        workspaceSearch.assertDoesNotExist()
        compose.onNodeWithText(app.getString(R.string.history_missing)).assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w960dp-h800dp")
    fun openingTheCurrentChatFromWorkspaceSearchReturnsToTheConversation() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        compose.waitUntilExactlyOneExists(hasText("Native history reply"), 10_000)
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        val find = compose.onNodeWithTag("conversation_find")
        find.assertIsDisplayed()

        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput("personal")
        compose
            .onNode(hasText("Personal chat") and hasAnyAncestor(hasTestTag("chat_search_results")))
            .performClick()

        compose.onNodeWithTag("chat_search").assertDoesNotExist()
        find.assertDoesNotExist()
        compose.onNodeWithText("Native history reply").assertIsDisplayed()
    }

    @Test
    fun findKeepsItsSnapshotDuringSyncAndClosesWhenTheConversationBecomesUnavailable() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Personal chat"))
        compose.onNodeWithText("Personal chat").performClick()
        val history = compose.runOnIdle {
            checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready,
                )
                .chats
                .history
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { history.uiState.value.phase == HistoryPhase.Ready }
        }

        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        compose.onNodeWithTag("conversation_find_query").performTextInput("Native history")
        compose.waitUntilExactlyOneExists(hasText("1 matching message"), 10_000)
        val rows = fixture.historyRows
        val lastRead = compose.runOnIdle { history.uiState.value.confirmation }
        val refreshStarted = CountDownLatch(1)
        val finishRefresh = CountDownLatch(1)
        fixture.historyRows = { request ->
            if (request.requestUrl?.pathSegments?.getOrNull(2) == CHAT_PERSONAL) {
                refreshStarted.countDown()
                finishRefresh.await()
            }
            rows(request)
        }
        try {
            compose.runOnIdle { history.invalidate(CHAT_PERSONAL) }
            compose.waitUntil(10_000) { refreshStarted.count == 0L }
            compose.onNodeWithTag("conversation_find_query").assertIsFocused()
            compose.onNodeWithText("Native history reply").assertIsDisplayed()
        } finally {
            finishRefresh.countDown()
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                val current = history.uiState.value
                current.phase == HistoryPhase.Ready && current.confirmation != lastRead
            }
        }
        compose.onNodeWithText("1 matching message").assertIsDisplayed()

        fixture.historyRows = { request ->
            if (request.requestUrl?.pathSegments?.getOrNull(2) == CHAT_PERSONAL)
                MockResponse().setResponseCode(403)
            else rows(request)
        }
        compose.runOnIdle { history.invalidate(CHAT_PERSONAL) }
        val missing = app.getString(R.string.history_missing)
        compose.waitUntilExactlyOneExists(hasText(missing), 10_000)
        compose.onNodeWithTag("conversation_find").assertDoesNotExist()
        compose.onNodeWithText("Native history reply").assertDoesNotExist()
        compose.onNodeWithText(missing).assertIsDisplayed()
        compose.onNodeWithTag("message_input").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w320dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun findKeepsTheMatchedTextVisibleWhenTheExcerptWraps() {
        val app = compose.activity.application as ChatListApplication
        val term = "M".repeat(38)
        val reply = "W".repeat(26) + " " + term
        app.fixture.historyCatchUp = { jsonResponse("""{"events":{},"notFoundThreads":[]}""") }
        app.fixture.historyRows = { request ->
            val after = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
            val thread = checkNotNull(request.requestUrl).pathSegments[2]
            val rows =
                if (after >= 37) ""
                else
                    historyEventWire(
                        thread = thread,
                        payload = """{"content":"$reply"}""",
                        run = null,
                    )
            jsonResponse(
                """{"rows":[$rows],"cursor":{"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":37},"hasMore":false}""",
            )
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Personal chat"))
        compose.onNodeWithText("Personal chat").performClick()
        compose.waitUntilExactlyOneExists(hasText(reply), 10_000)
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        compose.onNodeWithTag("conversation_find_query").performTextInput(term)
        compose.waitUntilExactlyOneExists(hasText("1 matching message"), 10_000)

        val snippet =
            compose.onNode(
                hasText(term, substring = true) and !hasSetTextAction(),
                useUnmergedTree = true,
            )
        val layouts = mutableListOf<TextLayoutResult>()
        snippet.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val layout = layouts.single()
        val match = layout.layoutInput.text.spanStyles.single()
        assertTrue(
            "The bold match must fit in the two-line result excerpt",
            layout.getLineEnd(layout.lineCount - 1, visibleEnd = true) >= match.end,
        )
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = ChatListApplication::class)
internal class ChatListRowActionsRootTest : ChatListRootTestFixture() {
    @Test
    fun chatRowReadActionsReconcileAndSurfaceFailedWrites() {
        val app = compose.activity.application as ChatListApplication
        val unread = AtomicBoolean(true)
        val rejectUnread = AtomicBoolean(true)
        app.fixture.indicators = {
            if (unread.get()) {
                jsonResponse(
                    """{"threads":{"$CHAT_IN_PROJECT":"unread"},"unreadAt":{"$CHAT_IN_PROJECT":"$CHAT_DATE"}}""",
                )
            } else {
                jsonResponse("""{"threads":{},"unreadAt":{}}""")
            }
        }
        app.fixture.commandResponse = { request ->
            if (request.method != "POST" || request.bodySize != 0L) null
            else
                when (request.requestUrl?.encodedPath) {
                    "/api/chat-threads/$CHAT_IN_PROJECT/mark-read" -> {
                        unread.set(false)
                        jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                    }
                    "/api/chat-threads/$CHAT_IN_PROJECT/mark-unread" ->
                        if (rejectUnread.get()) {
                            okhttp3.mockwebserver.MockResponse().setResponseCode(409)
                        } else {
                            unread.set(true)
                            jsonResponse("""{"lastReadAt":null}""")
                        }
                    else -> null
                }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        setResearchExpanded(true)
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Project chat"))
        val target = hasText("Project chat")
        val unreadStatus =
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread")
        val available = SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick)
        fun awaitAction(status: SemanticsMatcher) {
            compose.waitUntil(10_000) {
                compose
                    .onAllNodes(target.and(status).and(available))
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
        }
        fun choose(label: String) {
            compose.onNode(target).performSemanticsAction(SemanticsActions.OnLongClick)
            compose
                .onNode(target.and(hasAnyAncestor(hasTestTag("workspace_popup"))))
                .assertDoesNotExist()
            compose.onNodeWithText(label).performClick()
        }
        awaitAction(unreadStatus)
        choose("Mark as read")
        awaitAction(!unreadStatus)
        choose("Mark as unread")
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Could not update the read status.")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        awaitAction(!unreadStatus)
        rejectUnread.set(false)
        choose("Mark as unread")
        awaitAction(unreadStatus)
        compose.onNodeWithTag("conversation").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun markAllReadIncludesCollapsedArchivedChatsAndKeepsNewUnreadActivity() {
        val app = compose.activity.application as ChatListApplication
        val running = UUID.randomUUID().toString()
        val newer = "2026-11-13T00:01:00.000Z"
        val personalUnread = AtomicReference<String?>(CHAT_DATE)
        val projectUnread = AtomicBoolean(true)
        val rejectProject = AtomicBoolean(true)
        val activeUnreadQuery = AtomicReference<String?>()
        val marked = CopyOnWriteArrayList<String>()
        val releaseWrites = CountDownLatch(1)
        val releaseRefresh = CountDownLatch(1)
        val events =
            listOf(
                chatEventWire(),
                chatEventWire(
                    id = UUID.randomUUID().toString(),
                    seq = 18,
                    thread = CHAT_IN_PROJECT,
                    extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                    title = "Project chat",
                ),
                chatEventWire(
                    id = UUID.randomUUID().toString(),
                    seq = 19,
                    thread = CHAT_IN_PROJECT,
                    kind = "archived",
                ),
                chatEventWire(
                    id = UUID.randomUUID().toString(),
                    seq = 20,
                    thread = running,
                    title = "Running chat",
                ),
            )
        app.fixture.events = { request ->
            val rows =
                if (request.requestUrl?.queryParameter("sinceSeqId") == null) {
                    events.joinToString(",")
                } else ""
            jsonResponse("""{"events":[$rows],"hasMore":false}""")
        }
        app.fixture.indicators = {
            if (personalUnread.get() == newer) releaseRefresh.await()
            val unread = buildMap {
                personalUnread.get()?.let { put(CHAT_PERSONAL, it) }
                if (projectUnread.get()) put(CHAT_IN_PROJECT, CHAT_DATE)
            }
            val markers = unread.entries.joinToString(",") { (id, time) -> "\"$id\":\"$time\"" }
            val personal = if (CHAT_PERSONAL in unread) ",\"$CHAT_PERSONAL\":\"unread\"" else ""
            jsonResponse(
                """{"threads":{"$running":"active","$CHAT_IN_PROJECT":"active"$personal},"unreadAt":{$markers}}""",
            )
        }
        app.fixture.commandResponse = { request ->
            val url = request.requestUrl
            if (url?.encodedPath == "/api/indicators")
                activeUnreadQuery.set(url.queryParameter("includeActiveUnread"))
            val path = url?.pathSegments.orEmpty()
            if (request.method != "POST" || path.lastOrNull() != "mark-read") {
                null
            } else {
                val id = path[2]
                marked.add(id)
                releaseWrites.await()
                when (id) {
                    CHAT_PERSONAL -> {
                        // A newer reply finishes before the client receives the first receipt.
                        val receipt = personalUnread.getAndUpdate {
                            if (it == CHAT_DATE) newer else null
                        }
                        jsonResponse("""{"lastReadAt":"$receipt"}""")
                    }
                    CHAT_IN_PROJECT ->
                        if (rejectProject.get()) MockResponse().setResponseCode(409)
                        else {
                            projectUnread.set(false)
                            jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                        }
                    else -> MockResponse().setResponseCode(400)
                }
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val list = compose.onNodeWithTag("chat_list")
        val unread = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread")
        val projectUnreadCount =
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread 1, Active 1")
        val filter = compose.onNodeWithContentDescription("Filter")
        filter.performClick()
        val enabled = !SemanticsMatcher.keyIsDefined(SemanticsProperties.Disabled)
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasText("Mark all as read").and(enabled))
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        assertEquals("true", activeUnreadQuery.get())
        compose.onNodeWithText("Unread").performClick()
        setResearchExpanded(true)
        list.performScrollToNode(hasText("Project chat"))
        compose
            .onNodeWithText("Project chat")
            .assert(
                SemanticsMatcher.expectValue(
                    SemanticsProperties.StateDescription,
                    "Active, Unread",
                ),
            )
        setResearchExpanded(false)
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasText("Research").and(projectUnreadCount))
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithText("Project chat").assertDoesNotExist()

        fun markAll() {
            filter.performClick()
            compose.onNodeWithText("Mark all as read").assertIsEnabled().performClick()
        }
        fun awaitMessage(message: String) {
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(message).fetchSemanticsNodes().isNotEmpty()
            }
        }
        try {
            try {
                markAll()
                compose.waitUntil(10_000) { marked.size == 2 }
                compose.onNodeWithText("Personal chat").assertDoesNotExist()
                compose.onNodeWithText("Research").assertDoesNotExist()
            } finally {
                releaseWrites.countDown()
            }
            awaitMessage("Chats marked as read: 1. Failed: 1.")
        } finally {
            releaseRefresh.countDown()
        }
        assertEquals(setOf(CHAT_PERSONAL, CHAT_IN_PROJECT), marked.toSet())
        assertEquals(2, marked.size)
        compose.waitUntil(10_000) {
            currentList()?.indicators?.unreadAt?.get(CHAT_PERSONAL) == newer
        }
        list.performScrollToNode(hasText("Personal chat"))
        compose.onNodeWithText("Personal chat").assert(unread)
        compose.onNodeWithText("Research").assert(projectUnreadCount)
        rejectProject.set(false)
        markAll()
        awaitMessage("Marked 2 chats as read.")
        val feedback = compose.onNodeWithTag("chat_list_feedback").getUnclippedBoundsInRoot()
        val newChat = compose.onNodeWithText("New chat").getUnclippedBoundsInRoot()
        assertEquals(8f, (newChat.top - feedback.bottom).value, 1f)
        assertTrue(feedback.bottom - feedback.top >= 48.dp)
        compose.onNodeWithTag("chat_filter_heading").assert(hasText("Unread"))
        filter.performClick()
        compose
            .onNode(hasText("Unread").and(hasAnyAncestor(hasTestTag("workspace_popup"))))
            .assertIsSelected()
        compose.onNodeWithText("Archived").performClick()
        setResearchExpanded(true)
        list.performScrollToNode(hasText("Project chat"))
        compose
            .onNodeWithText("Project chat")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Active"))
        filter.performClick()
        compose.onNodeWithText("Inbox").performClick()
        list.performScrollToNode(hasText("Running chat"))
        compose
            .onNodeWithText("Running chat")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Active"))
    }

    @Test
    fun muteConfirmsAnUncertainWriteAndUnmuteRequiresAcknowledgement() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val events = fixture.rowEventTail()
        val commands = CopyOnWriteArrayList<RecordedRequest>()
        val rejectRead = AtomicBoolean(true)
        val unread = AtomicBoolean(true)
        val indicatorsUnavailable = AtomicBoolean(false)
        fixture.indicators = {
            if (indicatorsUnavailable.get()) MockResponse().setResponseCode(503)
            else {
                val value = if (unread.get()) "\"$CHAT_IN_PROJECT\":\"$CHAT_DATE\"" else ""
                val status = if (unread.get()) "\"$CHAT_IN_PROJECT\":\"unread\"" else ""
                jsonResponse("""{"threads":{$status},"unreadAt":{$value}}""")
            }
        }
        fixture.commandResponse = { request ->
            if (request.method != "POST") null
            else
                when (request.requestUrl?.encodedPath) {
                    "/api/chat-threads/$CHAT_IN_PROJECT/mute" -> {
                        commands.add(request)
                        events.add(
                            24L to
                                request.rowEvent(
                                    24,
                                    CHAT_IN_PROJECT,
                                    "sort_touched",
                                    ",\"muted\":true",
                                ),
                        )
                        MockResponse().setResponseCode(503)
                    }
                    "/api/chat-threads/$CHAT_IN_PROJECT/mark-read" -> {
                        commands.add(request)
                        if (rejectRead.get()) MockResponse().setResponseCode(503)
                        else {
                            unread.set(false)
                            jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                        }
                    }
                    "/api/chat-threads/$CHAT_IN_PROJECT/unmute" -> {
                        commands.add(request)
                        events.add(
                            25L to
                                request.rowEvent(
                                    25,
                                    CHAT_IN_PROJECT,
                                    "sort_touched",
                                    ",\"muted\":false",
                                ),
                        )
                        MockResponse().setResponseCode(204)
                    }
                    else -> null
                }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        setResearchExpanded(true)
        val target = hasText("Project chat")
        val row = compose.onNode(target)
        compose.onNodeWithTag("chat_list").performScrollToNode(target)
        val unreadBadge =
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread")
        compose.waitUntil(10_000) {
            compose.onAllNodes(target.and(unreadBadge)).fetchSemanticsNodes().isNotEmpty()
        }
        indicatorsUnavailable.set(true)
        row.performMouseInput { click(button = MouseButton.Secondary) }
        compose.onNodeWithText("Mute chat").performClick()

        val available = SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick)
        val muted = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Muted")
        val unconfirmed = "Could not confirm the chat change."
        val rejected = "Could not complete “Unmute chat”."
        compose.waitUntil(10_000) {
            compose.onAllNodes(target.and(muted).and(available)).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(unconfirmed).assertDoesNotExist()
        row.performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("Mark as read").assertDoesNotExist()
        compose.onNodeWithText("Mark as unread").assertDoesNotExist()
        compose.onNodeWithText("Unmute chat").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(rejected).fetchSemanticsNodes().isNotEmpty()
        }
        row.assert(muted)
        compose.onNodeWithText("Refresh chats").assertDoesNotExist()
        assertEquals(
            listOf("mute", "mark-read"),
            commands.map { it.requestUrl?.pathSegments?.last() },
        )

        rejectRead.set(false)
        awaitRowActionSettled(CHAT_IN_PROJECT)
        row.performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("Unmute chat").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodes(target.and(!muted).and(available)).fetchSemanticsNodes().isNotEmpty()
        }
        row.assert(!unreadBadge)
        indicatorsUnavailable.set(false)
        refreshWorkspaceChats()
        compose.waitUntil(10_000) {
            currentList()?.indicatorsPhase == ai.okou.android.chat.ChatReadPhase.Ready
        }
        compose.onNodeWithTag("chat_list").performScrollToNode(target)
        row.performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("Mark as unread").assertExists()
        compose.onNodeWithText("Mute chat").assertExists()
        assertEquals(
            listOf("mute", "mark-read", "mark-read", "unmute"),
            commands.map { it.requestUrl?.pathSegments?.last() },
        )
        assertEquals(
            2,
            commands.mapNotNull { it.requestUrl?.queryParameter("eventId") }.distinct().size,
        )
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun markingReadInUnreadCanBeUndoneThroughCanonicalReadActions() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        val unread = AtomicBoolean(true)
        val commands = CopyOnWriteArrayList<String>()
        val releaseUndo = CountDownLatch(1)
        app.fixture.indicators = {
            if (unread.get())
                jsonResponse(
                    """{"threads":{"$CHAT_PERSONAL":"unread"},"unreadAt":{"$CHAT_PERSONAL":"$CHAT_DATE"}}""",
                )
            else jsonResponse("""{"threads":{},"unreadAt":{}}""")
        }
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/mark-read" -> {
                    unread.set(false)
                    commands.add("read")
                    jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                }
                "/api/chat-threads/$CHAT_PERSONAL/mark-unread" -> {
                    commands.add("unread")
                    check(releaseUndo.await(10, TimeUnit.SECONDS))
                    unread.set(true)
                    jsonResponse("""{"lastReadAt":null}""")
                }
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Unread").performClick()
        val rowTag = "chat_$CHAT_PERSONAL"
        compose.onNodeWithTag("chat_list").performScrollToNode(hasTestTag(rowTag))
        compose.onNodeWithTag(rowTag).performTouchInput {
            swipe(center.copy(x = width * 0.2f), center)
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Chat marked as read").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag(rowTag).assertDoesNotExist()
        val undo = compose.onNodeWithText("Undo")
        try {
            undo.performKeyInput { pressKey(Key.Tab) }
            undo.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
            undo.performKeyInput { pressKey(Key.Enter) }
            compose.waitUntil(5_000) { commands.size == 2 }
            compose.waitUntilExactlyOneExists(hasTestTag(rowTag) and isFocused(), 5_000)
            compose.onNodeWithTag(rowTag).assertIsDisplayed()
            undo.assertDoesNotExist()
            assertFalse(unread.get())
        } finally {
            releaseUndo.countDown()
        }
        compose.waitUntil(10_000) {
            unread.get() && commands.size == 2 && currentList()?.rowUndo == null
        }
        compose.onNodeWithTag(rowTag).assertExists()
        assertEquals(listOf("read", "unread"), commands.toList())
        compose.onNodeWithText("Undo").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun aCommittedArchiveSwipeOffersUndoAcrossFiltersAndRename() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        val commands = CopyOnWriteArrayList<RecordedRequest>()
        val releaseRename = CountDownLatch(1)
        val releaseUndo = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    commands.add(request)
                    events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                    commands.add(request)
                    releaseUndo.await()
                    events.add(26L to request.rowEvent(26, CHAT_PERSONAL, "unarchived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/rename" -> {
                    commands.add(request)
                    releaseRename.await()
                    val body = request.jsonCommandBody()
                    events.add(
                        25L to
                            chatEventWire(
                                id = body.getValue("eventId").jsonPrimitive.content,
                                seq = 25,
                                kind = "renamed",
                                title = body.getValue("title").jsonPrimitive.content,
                            ),
                    )
                    MockResponse().setResponseCode(204)
                }
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val rowTag = "chat_$CHAT_PERSONAL"
        val row = compose.onNodeWithTag(rowTag)
        compose.onNodeWithTag("chat_list").performScrollToNode(hasTestTag(rowTag))
        val left = row.getUnclippedBoundsInRoot().left
        row.performTouchInput { swipe(center, center.copy(x = centerX - 44.dp.toPx())) }
        row.assertIsDisplayed()
        assertEquals(left, row.getUnclippedBoundsInRoot().left)
        row.performTouchInput {
            swipe(center, center.copy(x = centerX - 90.dp.toPx(), y = centerY - 120.dp.toPx()))
        }
        assertEquals(left, row.getUnclippedBoundsInRoot().left)
        row.performTouchInput {
            down(center)
            moveTo(center + Offset(-104.dp.toPx(), 0f))
            moveTo(center + Offset(-96.dp.toPx(), 72.dp.toPx()))
            up()
        }
        row.assertIsDisplayed()
        assertEquals(left, row.getUnclippedBoundsInRoot().left)
        assertTrue(commands.isEmpty())

        row.performTouchInput { swipe(center.copy(x = width * 0.8f), center) }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Chat archived").fetchSemanticsNodes().isNotEmpty()
        }
        row.assertDoesNotExist()
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Archived").performClick()
        val undo = compose.onNodeWithText("Undo").assertIsDisplayed()
        val dismiss = compose.onNodeWithContentDescription("Dismiss")
        val undoBounds = undo.getUnclippedBoundsInRoot()
        val dismissBounds = dismiss.getUnclippedBoundsInRoot()
        val messageBounds = compose.onNodeWithText("Chat archived").getUnclippedBoundsInRoot()
        assertEquals(
            (messageBounds.top + messageBounds.bottom).value / 2,
            (undoBounds.top + undoBounds.bottom).value / 2,
            1f,
        )
        assertEquals(4f, (dismissBounds.left - undoBounds.right).value, 1f)
        for (bounds in listOf(undoBounds, dismissBounds)) {
            assertTrue(bounds.right - bounds.left >= 48.dp && bounds.bottom - bounds.top >= 48.dp)
        }
        awaitRowActionSettled(CHAT_PERSONAL)
        try {
            compose.runOnIdle {
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready,
                    )
                    .chats
                    .renameThread(CHAT_PERSONAL, "Weekly brief")
            }
            compose.waitUntil(10_000) { commands.size == 2 }
            undo.assertIsDisplayed().assertIsNotEnabled()
        } finally {
            releaseRename.countDown()
        }
        awaitRowActionSettled(CHAT_PERSONAL)
        assertEquals(2, commands.size)
        try {
            undo.assertIsEnabled().performKeyInput { pressKey(Key.Tab) }
            undo.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
            undo.performKeyInput { pressKey(Key.Enter) }
            compose.waitUntil(5_000) { commands.size == 3 }
            compose.waitUntilExactlyOneExists(hasTestTag("chat_list") and isFocused(), 5_000)
            row.assertDoesNotExist()
            undo.assertDoesNotExist()
            compose.onNodeWithTag("chat_filter_heading").assert(hasText("Archived"))
        } finally {
            releaseUndo.countDown()
        }
        compose.waitUntil(10_000) {
            currentList()?.threads?.any {
                it.id == CHAT_PERSONAL && !it.archived && it.title == "Weekly brief"
            } == true && commands.size == 3 && currentList()?.rowUndo == null
        }
        assertEquals(
            listOf("archive", "rename", "unarchive"),
            commands.map { it.requestUrl?.pathSegments?.last() },
        )
        compose.onNodeWithText("Undo").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    fun deletingTheSelectedChatRequiresConfirmationAndReturnsToTheListWhilePending() {
        val app = compose.activity.application as ChatListApplication
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val requests = AtomicInteger()
        val events = app.fixture.rowEventTail()
        app.fixture.commandResponse = { request ->
            if (
                request.method != "DELETE" ||
                    request.requestUrl?.encodedPath != "/api/chat-threads/$CHAT_PERSONAL"
            )
                null
            else {
                requests.incrementAndGet()
                started.countDown()
                release.await()
                events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "deleted"))
                MockResponse().setResponseCode(204)
            }
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            val rowTag = "chat_$CHAT_PERSONAL"
            val row = compose.onNodeWithTag(rowTag)
            compose.onNodeWithTag("chat_list").performScrollToNode(hasTestTag(rowTag))
            row.performClick()
            compose.onNodeWithTag("conversation").assertExists()
            fun openConfirmation() {
                row.performTouchInput { longClick() }
                compose.onNodeWithText("Delete chat").performClick()
                compose.onNodeWithText("Delete chat?").assertIsDisplayed()
            }
            openConfirmation()
            compose.onNodeWithText("Cancel").performClick()
            row.assertIsDisplayed().assertIsSelected()
            assertEquals(0, requests.get())

            openConfirmation()
            compose.onNodeWithText("Delete chat").performClick()
            compose.waitUntil(10_000) { started.count == 0L }
            row.assertDoesNotExist()
            compose.onNodeWithTag("conversation").assertDoesNotExist()
            compose.onNodeWithTag("workspace_new_chat").assertExists()
            compose.onNodeWithText("Undo").assertDoesNotExist()
            release.countDown()
            compose.waitUntil(10_000) {
                currentList()?.let { list ->
                    CHAT_PERSONAL !in list.pendingRowActions &&
                        list.threads.none { it.id == CHAT_PERSONAL }
                } == true
            }
            row.assertDoesNotExist()
            assertEquals(1, requests.get())
        } finally {
            release.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun rejectedChatDeletionShowsOneMessageInTheListAfterNavigation() {
        val app = compose.activity.application as ChatListApplication
        val deleteStarted = CountDownLatch(1)
        val rejectDelete = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            if (
                request.method == "DELETE" &&
                    request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL"
            ) {
                deleteStarted.countDown()
                rejectDelete.await()
                MockResponse().setResponseCode(400)
            } else null
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val row = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        val otherRow = compose.onNodeWithTag("chat_$CHAT_IN_PROJECT")
        val back = compose.onNodeWithContentDescription("Back")
        val failure = "Could not delete the chat."
        try {
            setResearchExpanded(true)
            row.performClick()
            compose.onNodeWithContentDescription("Chat actions").performClick()
            compose.onNodeWithText("Delete chat").performClick()
            compose.onNodeWithText("Delete chat").performClick()
            compose.waitUntil(10_000) { deleteStarted.count == 0L }
            row.assertDoesNotExist()
            otherRow.performClick()
            compose.onNodeWithTag("chat_list").assertDoesNotExist()

            rejectDelete.countDown()
            compose.waitUntil(10_000) {
                currentList()?.rowActionFailures?.any { it.rejected } == true
            }
            compose.onNodeWithText(failure).assertDoesNotExist()
            back.performClick()
            row.assertIsDisplayed()
            val listFeedback = hasAnyAncestor(hasTestTag("chat_list_feedback"))
            compose.onNode(hasText(failure) and listFeedback).assertIsDisplayed()

            otherRow.performClick()
            compose.waitUntil(10_000) { currentList()?.rowActionFailures?.isEmpty() == true }
            back.performClick()
            row.assertIsDisplayed()
            compose.onNodeWithText(failure).assertDoesNotExist()
        } finally {
            rejectDelete.countDown()
        }
    }

    @Test
    fun aRejectedArchiveSwipeRestoresTheRowDuringRefreshAndCanBeRetried() {
        val app = compose.activity.application as ChatListApplication
        val requests = AtomicInteger()
        val holdRead = AtomicBoolean(false)
        val reading = CountDownLatch(1)
        val releaseRead = CountDownLatch(1)
        val writing = CountDownLatch(1)
        val rejectWrite = CountDownLatch(1)
        val events = app.fixture.rowEventTail()
        val eventResponse = app.fixture.events
        app.fixture.events = { request ->
            if (holdRead.get() && request.requestUrl?.queryParameter("sinceSeqId") != null) {
                reading.countDown()
                releaseRead.await()
            }
            eventResponse(request)
        }
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath != "/api/chat-threads/$CHAT_PERSONAL/archive") null
            else if (requests.incrementAndGet() == 1) {
                writing.countDown()
                rejectWrite.await()
                MockResponse().setResponseCode(400)
            } else {
                events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                MockResponse().setResponseCode(204)
            }
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            val rowTag = "chat_$CHAT_PERSONAL"
            val row = compose.onNodeWithTag(rowTag)
            compose.onNodeWithTag("chat_list").performScrollToNode(hasTestTag(rowTag))
            holdRead.set(true)
            refreshWorkspaceChats()
            compose.waitUntil(10_000) { compose.runOnIdle { reading.count == 0L } }
            row.performTouchInput { swipe(center.copy(x = width * 0.8f), center) }
            compose.waitUntil(10_000) { compose.runOnIdle { writing.count == 0L } }
            row.assertDoesNotExist()
            rejectWrite.countDown()
            compose.waitUntil(10_000) {
                compose
                    .onAllNodesWithText("Could not complete “Archive chat”.")
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            row.assertIsDisplayed()
            compose.onNodeWithText("Refresh chats").assertDoesNotExist()
            compose.onNodeWithText("Undo").assertDoesNotExist()
            awaitRowActionSettled(CHAT_PERSONAL)

            releaseRead.countDown()
            row.performTouchInput { swipe(center.copy(x = width * 0.8f), center) }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Chat archived").fetchSemanticsNodes().isNotEmpty()
            }
            row.assertDoesNotExist()
            assertEquals(2, requests.get())
        } finally {
            rejectWrite.countDown()
            releaseRead.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun compactConversationKeepsArchiveUndoBetweenJumpAndComposer() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        fixture.historyReply = List(32) { "Reply paragraph ${it + 1}." }.joinToString("\n\n")
        val events = fixture.rowEventTail()
        fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                    events.add(25L to request.rowEvent(25, CHAT_PERSONAL, "unarchived"))
                    MockResponse().setResponseCode(204)
                }
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performClick()
        compose.waitUntilExactlyOneExists(hasText("Reply paragraph 32."), 10_000)
        compose.onNodeWithTag("conversation").performScrollToNode(hasText("Hello history"))
        val jump = hasTestTag("conversation_jump")
        compose.waitUntilExactlyOneExists(jump, 10_000)
        val composer = compose.onNodeWithTag("chat_composer").assertIsDisplayed()
        val bottom = composer.getUnclippedBoundsInRoot().bottom
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Archive chat").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasText("Undo") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        val feedback = compose.onNodeWithTag("conversation_feedback").assertIsDisplayed()
        val feedbackBounds = feedback.getUnclippedBoundsInRoot()
        val jumpBounds = compose.onNode(jump).assertIsDisplayed().getUnclippedBoundsInRoot()
        assertEquals(
            "Gap below the reading jump",
            8f,
            (feedbackBounds.top - jumpBounds.bottom).value,
            1f,
        )
        val composerTop = composer.getUnclippedBoundsInRoot().top
        assertEquals(8f, (composerTop - feedbackBounds.bottom).value, 1f)
        val undoBounds = compose.onNodeWithText("Undo").getUnclippedBoundsInRoot()
        assertTrue(undoBounds.right - undoBounds.left >= 48.dp)
        assertTrue(undoBounds.bottom - undoBounds.top >= 48.dp)
        compose.onNodeWithText("Undo").assertIsDisplayed().performClick()
        compose.onNodeWithTag("conversation").assertIsDisplayed()
        assertEquals(bottom, composer.assertIsDisplayed().getUnclippedBoundsInRoot().bottom)
        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasTestTag("chat_$CHAT_PERSONAL")).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun splitConversationKeepsArchiveFeedbackWithTheInitiatingConversation() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val events = fixture.rowEventTail()
        val accept = AtomicBoolean(false)
        fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath != "/api/chat-threads/$CHAT_PERSONAL/archive") null
            else if (!accept.get()) MockResponse().setResponseCode(400)
            else {
                events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                MockResponse().setResponseCode(204)
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val row = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        row.performClick()

        fun archiveFromConversation() {
            compose.onNodeWithContentDescription("Chat actions").performClick()
            compose.onNodeWithText("Archive chat").performClick()
        }
        fun assertConversationFeedback(message: String) {
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(message).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithTag("conversation_feedback").assertIsDisplayed()
            compose.onNodeWithTag("chat_list_feedback").assertDoesNotExist()
        }
        archiveFromConversation()
        assertConversationFeedback("Could not complete “Archive chat”.")
        row.assertIsDisplayed()

        accept.set(true)
        archiveFromConversation()
        assertConversationFeedback("Undo")
        row.assertDoesNotExist()

        val originalQualifiers = RuntimeEnvironment.getQualifiers()
        try {
            RuntimeEnvironment.setQualifiers("en-rUS-w400dp-h800dp")
            compose.activityRule.scenario.recreate()
            compose.activityRule.scenario.onActivity {
                assertEquals(400, it.resources.configuration.screenWidthDp)
            }
            compose.onNodeWithTag("chat_list").assertDoesNotExist()
            assertConversationFeedback("Undo")

            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithTag("chat_list").assertIsDisplayed()
            compose.onNodeWithText("Undo").assertDoesNotExist()
        } finally {
            RuntimeEnvironment.setQualifiers(originalQualifiers)
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun aConversationFailureAndListFeedbackAreVisibleAtTheSameTime() {
        val app = compose.activity.application as ChatListApplication
        val deleteStarted = CountDownLatch(1)
        val releaseDelete = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/projects/$CHAT_PROJECT" ->
                    if (request.method == "DELETE") {
                        deleteStarted.countDown()
                        releaseDelete.await()
                        MockResponse().setResponseCode(503)
                    } else null
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> MockResponse().setResponseCode(400)
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performClick()
        compose.onNodeWithText("Research").performMouseInput {
            click(button = MouseButton.Secondary)
        }
        compose.onNodeWithText("Delete Project").performClick()
        try {
            compose.onNodeWithText("Delete Project").performClick()
            compose.waitUntil(10_000) { deleteStarted.count == 0L }
            compose.onNodeWithText("Cancel").performClick()
        } finally {
            releaseDelete.countDown()
        }
        val listNotice = "Could not delete the Project."
        val inList = hasAnyAncestor(hasTestTag("chat_list_feedback"))
        val inConversation = hasAnyAncestor(hasTestTag("conversation_feedback"))
        compose.waitUntilExactlyOneExists(hasText(listNotice) and inList, 10_000)

        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Archive chat").performClick()
        val conversationNotice = hasText("Could not complete “Archive chat”.")
        compose.waitUntilExactlyOneExists(conversationNotice and inConversation, 10_000)
        compose.onNode(hasText(listNotice) and inList).assertIsDisplayed()
        compose.onNode(hasText("Try again") and inList).assertDoesNotExist()
        compose.onNode(hasContentDescription("Dismiss") and inList).assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun allRejectedBatchReadsTemporarilyReplaceTheListUndo() {
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                    events.add(25L to request.rowEvent(25, CHAT_PERSONAL, "unarchived"))
                    MockResponse().setResponseCode(204)
                }
                else ->
                    if (request.requestUrl?.pathSegments?.lastOrNull() == "mark-read")
                        MockResponse().setResponseCode(409)
                    else null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val row = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        row.performTouchInput { longClick() }
        compose.onNodeWithText("Archive chat").performClick()
        val undo = hasText("Undo")
        compose.waitUntilExactlyOneExists(undo, 10_000)

        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Mark all as read").performClick()
        val failure = hasText("Could not mark chats as read.")
        compose.waitUntilExactlyOneExists(failure, 10_000)
        compose.onNode(undo).assertDoesNotExist()

        compose.mainClock.advanceTimeBy(FEEDBACK_TIMEOUT_MILLIS)
        compose.onNode(failure).assertDoesNotExist()
        compose.onNode(undo).performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("chat_$CHAT_PERSONAL"), 10_000)
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun eachPaneKeepsItsUndoWhileListErrorsFinishInOrder() {
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_IN_PROJECT/archive" -> {
                    events.add(25L to request.rowEvent(25, CHAT_IN_PROJECT, "archived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_IN_PROJECT/unarchive" ->
                    MockResponse().setResponseCode(400)
                "/api/chat-threads/$CHAT_IN_PROJECT/mark-read" ->
                    MockResponse().setResponseCode(409)
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performClick()
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Archive chat").performClick()
        val listHost = hasAnyAncestor(hasTestTag("chat_list_feedback"))
        val conversationHost = hasAnyAncestor(hasTestTag("conversation_feedback"))
        val undo = hasText("Undo")
        compose.waitUntilExactlyOneExists(undo and conversationHost, 10_000)

        setResearchExpanded(true)
        compose.onNodeWithTag("chat_$CHAT_IN_PROJECT").performTouchInput { longClick() }
        compose.onNodeWithText("Archive chat").performClick()
        compose.waitUntilExactlyOneExists(undo and listHost, 10_000)
        compose.onNode(undo and conversationHost).assertIsDisplayed()

        val filter = compose.onNodeWithContentDescription("Filter")
        filter.performClick()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithTag("chat_$CHAT_IN_PROJECT").performTouchInput { longClick() }
        compose.onNodeWithText("Unarchive chat").performClick()
        val firstError = hasText("Could not complete “Unarchive chat”.") and listHost
        compose.waitUntilExactlyOneExists(firstError, 10_000)
        compose.onNode(undo and conversationHost).assertIsDisplayed()

        filter.performClick()
        compose.onNodeWithText("Mark all as read").performClick()
        compose.waitUntil(10_000) { currentList()?.markAllReadResults?.isNotEmpty() == true }
        val secondError = hasText("Could not mark chats as read.") and listHost
        compose.onNode(firstError).assertIsDisplayed()
        compose.onNode(secondError).assertDoesNotExist()
        compose.mainClock.advanceTimeBy(FEEDBACK_TIMEOUT_MILLIS)
        compose.onNode(secondError).assertIsDisplayed()
        compose.onNode(undo and conversationHost).assertIsDisplayed()
        compose.mainClock.advanceTimeBy(FEEDBACK_TIMEOUT_MILLIS)
        compose.onNode(undo and listHost).assertIsDisplayed()
        compose.onNode(undo and conversationHost).assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun archiveAndRestoreUpdatePlacementAndKeepTheOpenConversation() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val readback = CountDownLatch(1)
        val release = CountDownLatch(1)
        val events = fixture.rowEventTail {
            if (it == 23L) {
                readback.countDown()
                release.await()
            }
        }
        val commands = CopyOnWriteArrayList<RecordedRequest>()
        fixture.commandResponse = { request ->
            if (request.method != "POST") null
            else
                when (request.requestUrl?.encodedPath) {
                    "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                        commands.add(request)
                        events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                        MockResponse().setResponseCode(204)
                    }
                    "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                        commands.add(request)
                        events.add(25L to request.rowEvent(25, CHAT_PERSONAL, "unarchived"))
                        MockResponse().setResponseCode(204)
                    }
                    else -> null
                }
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            val rowTag = "chat_$CHAT_PERSONAL"
            val target = hasTestTag(rowTag)
            val row = compose.onNode(target)
            compose.onNodeWithTag("chat_list").performScrollToNode(target)
            row.performClick()
            compose.waitUntil(10_000) {
                compose
                    .onAllNodesWithText("Native history", substring = true)
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            row.performTouchInput {
                val second = center.copy(x = width * 0.45f)
                down(0, center.copy(x = width * 0.8f))
                down(1, second)
                up(0)
                moveTo(1, second.copy(x = second.x - 20.dp.toPx()))
                up(1)
            }
            row.assertIsDisplayed()
            row.performTouchInput {
                val first = center.copy(x = width * 0.8f)
                val second = center.copy(x = width * 0.55f)
                down(0, first)
                moveTo(0, first.copy(x = first.x - 24.dp.toPx()))
                down(1, second)
                up(0)
                moveTo(1, second.copy(x = second.x - 84.dp.toPx()))
                up(1)
            }
            row.assertIsDisplayed()
            assertTrue(commands.isEmpty())
            row.performTouchInput { longClick() }
            compose.onNodeWithText("Archive chat").performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { readback.count == 0L } }
            row.assertDoesNotExist()
            compose.onNodeWithTag("conversation").assertExists()
            release.countDown()
            compose.waitUntil(10_000) { compose.onAllNodes(target).fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithContentDescription("Filter").performClick()
            compose.onNodeWithText("Archived").performClick()
            val filterLabel = "Archived"
            val filterLayouts = mutableListOf<TextLayoutResult>()
            compose
                .onNodeWithTag("chat_filter_heading", useUnmergedTree = true)
                .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { read ->
                    read(filterLayouts)
                }
            val filterLayout = filterLayouts.single()
            assertEquals(filterLabel.length, filterLayout.getLineEnd(0, visibleEnd = true))
            compose.onNodeWithTag("chat_list").performScrollToNode(target)
            awaitRowActionSettled(CHAT_PERSONAL)
            compose.onNodeWithTag(rowTag).performSemanticsAction(SemanticsActions.OnLongClick)
            compose.onNodeWithText("Unarchive chat").performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(target).fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithContentDescription("Filter").performClick()
            compose.onNodeWithText("Inbox").performClick()
            compose.onNodeWithTag("chat_list").performScrollToNode(target)
            compose.onNodeWithTag(rowTag).assertExists()
            compose.onNodeWithTag("conversation").assertExists()
            awaitRowActionSettled(CHAT_PERSONAL)
            assertEquals(
                listOf("archive", "unarchive"),
                commands.map { it.requestUrl?.pathSegments?.last() },
            )
            assertEquals(
                2,
                commands.mapNotNull { it.requestUrl?.queryParameter("eventId") }.distinct().size,
            )
        } finally {
            release.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun chatTitleWaitsForConfirmationWhilePinningAppearsImmediately() {
        val app = compose.activity.application as ChatListApplication
        val readback = CountDownLatch(1)
        val release = CountDownLatch(1)
        val pinResponse = CountDownLatch(1)
        val renameEvent = AtomicReference<String>()
        val fixture = app.fixture
        val events = fixture.rowEventTail {
            readback.countDown()
            release.await()
        }
        val commands = CopyOnWriteArrayList<RecordedRequest>()
        fixture.commandResponse = { request ->
            if (request.method != "POST") null
            else
                when (request.requestUrl?.encodedPath) {
                    "/api/chat-threads/$CHAT_PERSONAL/rename" -> {
                        commands.add(request)
                        val body = request.jsonCommandBody()
                        renameEvent.set(
                            chatEventWire(
                                id = body.getValue("eventId").jsonPrimitive.content,
                                seq = 24,
                                kind = "renamed",
                                title = body.getValue("title").jsonPrimitive.content,
                            ),
                        )
                        MockResponse().setResponseCode(503)
                    }
                    "/api/chat-threads/$CHAT_PERSONAL/pin" -> {
                        commands.add(request)
                        pinResponse.await()
                        val rank = request.requestUrl?.queryParameter("pinOrder")
                        events.add(
                            25L to
                                request.rowEvent(
                                    25,
                                    CHAT_PERSONAL,
                                    "pinned",
                                    ",\"pinOrder\":\"$rank\"",
                                ),
                        )
                        MockResponse().setResponseCode(204)
                    }
                    "/api/chat-threads/$CHAT_PERSONAL/unpin" -> {
                        commands.add(request)
                        events.add(26L to request.rowEvent(26, CHAT_PERSONAL, "unpinned"))
                        MockResponse().setResponseCode(204)
                    }
                    else -> null
                }
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Personal chat").fetchSemanticsNodes().isNotEmpty()
            }
            val row = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
            fun choose(label: String) {
                row.performSemanticsAction(SemanticsActions.OnLongClick)
                compose.onNodeWithText(label).performClick()
            }
            compose.runOnIdle {
                val model =
                    checkNotNull(
                            ViewModelProvider(compose.activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready,
                        )
                        .chats
                model.renameThread(CHAT_PERSONAL, "   ")
                model.renameThread(CHAT_PERSONAL, "Personal chat")
                model.renameThread(CHAT_PERSONAL, "  Weekly brief  ")
                assertEquals(
                    ChatRowAction.Rename,
                    model.uiState.value.pendingRowActions[CHAT_PERSONAL],
                )
            }
            awaitRowActionSettled(CHAT_PERSONAL)
            row.assert(hasText("Personal chat"))
            assertEquals(1, commands.size)
            events.add(24L to checkNotNull(renameEvent.get()))
            refreshWorkspaceChats()
            compose.waitUntil(10_000) { readback.count == 0L }
            row.assert(hasText("Personal chat"))
            release.countDown()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Weekly brief").fetchSemanticsNodes().isNotEmpty()
            }

            val pinned =
                SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Active, Pinned")
            val personal = hasTestTag("chat_$CHAT_PERSONAL")
            row.performSemanticsAction(SemanticsActions.OnLongClick)
            compose.onNodeWithText("Rename chat").assertExists()
            compose.onNodeWithText("Pin chat").performClick()
            val pendingPin =
                SemanticsMatcher.expectValue(
                    SemanticsProperties.StateDescription,
                    "Active, Pinned, Updating chat…",
                )
            compose.waitUntil(10_000) {
                compose.onAllNodes(personal.and(pendingPin)).fetchSemanticsNodes().isNotEmpty()
            }
            pinResponse.countDown()
            awaitRowActionSettled(CHAT_PERSONAL)
            compose.waitUntil(10_000) {
                compose.onAllNodes(personal.and(pinned)).fetchSemanticsNodes().isNotEmpty()
            }
            choose("Unpin chat")
            awaitRowActionSettled(CHAT_PERSONAL)
            compose.waitUntil(10_000) {
                compose.onAllNodes(personal.and(!pinned)).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithTag("conversation").assertDoesNotExist()
            assertEquals(
                listOf("rename", "pin", "unpin"),
                commands.map { it.requestUrl?.pathSegments?.last() },
            )
            assertEquals(
                "Weekly brief",
                commands[0].jsonCommandBody().getValue("title").jsonPrimitive.content,
            )
            assertEquals("a0", commands[1].requestUrl?.queryParameter("pinOrder"))
            val renameId = commands[0].jsonCommandBody().getValue("eventId").jsonPrimitive.content
            assertEquals(renameId, UUID.fromString(renameId).toString())
            assertEquals(
                3,
                (listOf(renameId) +
                        commands.drop(1).mapNotNull { it.requestUrl?.queryParameter("eventId") })
                    .distinct()
                    .size,
            )
        } finally {
            release.countDown()
            pinResponse.countDown()
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = ChatListApplication::class)
internal class ChatListProjectsRootTest : ChatListRootTestFixture() {
    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun emptyListActionsWaitForTheFirstConfirmedChatSnapshot() {
        val app = compose.activity.application as ChatListApplication
        val releaseChats = CountDownLatch(1)
        app.fixture.events = { request ->
            val initialRead = request.requestUrl?.queryParameter("sinceSeqId") == null
            if (initialRead) releaseChats.await()
            val events = if (initialRead) chatEventWire() else ""
            jsonResponse("""{"events":[$events],"hasMore":false}""")
        }
        val project = compose.onNodeWithText("Research")
        val action = compose.onNodeWithText("New chat in this Project")
        val archiveEmpty = compose.onNodeWithText("No archived chats")
        try {
            app.responseGate.countDown()
            compose.waitUntilExactlyOneExists(hasText("Research"), 10_000)
            compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Research"))
            project.performClick()
            project.assert(SemanticsMatcher.keyIsDefined(SemanticsActions.Collapse))
            action.assertDoesNotExist()

            compose.onNodeWithContentDescription("Filter").performClick()
            compose.onNodeWithText("Archived").performClick()
            compose.onNodeWithTag("chat_filter_heading").assert(hasText("Archived"))
            archiveEmpty.assertDoesNotExist()
        } finally {
            releaseChats.countDown()
        }

        compose.waitUntilExactlyOneExists(hasText("No archived chats"), 10_000)
        compose.onNodeWithText("Back to Inbox").performClick()
        compose.waitUntilExactlyOneExists(hasText("New chat in this Project"), 10_000)
        action.performClick()
        compose.onNodeWithText("Research").assertExists()
        compose.onNodeWithTag("message_input").assertIsDisplayed()
    }

    @Test
    fun aPopulatedProjectStartsItsOwnChatFromTheRowMenu() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Research"))
        compose.onNodeWithText("Research").performSemanticsAction(SemanticsActions.OnLongClick)
        compose
            .onNode(hasText("Research").and(hasAnyAncestor(hasTestTag("workspace_popup"))))
            .assertDoesNotExist()
        compose.onNodeWithText("New chat in this Project").performClick()
        compose.onNodeWithText("Research").assertExists()
        compose.onNodeWithTag("message_input").assertExists()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun successfulProjectRenameClosesWithTheNameReturnedByTheServer() {
        val app = compose.activity.application as ChatListApplication
        val writeSent = AtomicBoolean()
        val readbackStarted = CountDownLatch(1)
        val releaseReadback = CountDownLatch(1)
        val readEvents = app.fixture.projectEvents
        app.fixture.projectEvents = { request ->
            if (writeSent.get()) {
                readbackStarted.countDown()
                releaseReadback.await()
            }
            readEvents(request)
        }
        app.fixture.commandResponse = { request ->
            if (
                request.method == "PATCH" &&
                    request.requestUrl?.encodedPath == "/api/projects/$CHAT_PROJECT"
            ) {
                writeSent.set(true)
                jsonResponse(
                    """{"id":"$CHAT_PROJECT","name":"Newer name","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}""",
                )
            } else null
        }
        app.responseGate.countDown()
        awaitListAndNames()

        try {
            compose.onNodeWithText("Research").performTouchInput { longClick() }
            compose.onNodeWithText("Rename").performClick()
            val editor = compose.onNodeWithContentDescription("Project name")
            editor.performTextReplacement("Submitted name")
            editor.assertTextContains("Submitted name")
            compose.onNodeWithText("Save").assertIsEnabled().performClick()
            compose.waitUntilExactlyOneExists(hasText("Newer name"), 10_000)

            editor.assertDoesNotExist()
            compose.onNodeWithText("Newer name").assertIsDisplayed()
            compose.onNodeWithText("Project name saved").assertIsDisplayed()
            compose.waitUntil(10_000) { readbackStarted.count == 0L }
            compose.onNodeWithText("Newer name").performTouchInput { longClick() }
            compose.onNodeWithText("Rename").assertIsEnabled().performClick()
            editor.assertTextContains("Newer name")
            compose.onNodeWithText("Save").assertIsNotEnabled()
        } finally {
            releaseReadback.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w450dp-h850dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun ambiguousProjectRenameKeepsTheFormAndIgnoresALateSuccessForPresentation() {
        val app = compose.activity.application as ChatListApplication
        val pending = CountDownLatch(1)
        val writes = CopyOnWriteArrayList<String>()
        val reads = AtomicInteger()
        val committed = AtomicReference<String?>()
        app.fixture.commandResponse = { request ->
            if (
                request.method != "PATCH" ||
                    request.requestUrl?.encodedPath != "/api/projects/$CHAT_PROJECT"
            ) {
                null
            } else {
                val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                check(body.getValue("name").jsonPrimitive.content == "Field notes")
                val eventId = body.getValue("eventId").jsonPrimitive.content
                writes.add(eventId)
                pending.await()
                MockResponse().setResponseCode(503)
            }
        }
        app.fixture.projectEvents = { request ->
            reads.incrementAndGet()
            val event =
                committed.get()?.takeIf { request.requestUrl?.queryParameter("sinceSeqId") == "0" }
            val rows =
                if (event == null) ""
                else
                    """{"id":"$event","seqId":1,"projectId":"$CHAT_PROJECT","kind":"renamed","name":"Field notes","createdAt":"$CHAT_DATE"}"""
            jsonResponse("""{"events":[$rows],"hasMore":false}""")
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val editor = compose.onNodeWithContentDescription("Project name")
        val save = compose.onNodeWithText("Save")
        var beforeSaveReads = 0
        try {
            compose.onNodeWithText("Research").performTouchInput { longClick() }
            compose.onNodeWithText("Rename").performClick()
            editor.performTextReplacement("a".repeat(121))
            val nameTooLong = app.getString(R.string.chat_project_name_too_long, 120)
            val lengthError = compose.onNodeWithText(nameTooLong, useUnmergedTree = true)
            lengthError.assertDoesNotExist()
            val fieldBounds = editor.getUnclippedBoundsInRoot()
            val saveBounds = save.getUnclippedBoundsInRoot()
            save.performClick()
            lengthError.assertIsDisplayed()
            editor.assert(SemanticsMatcher.expectValue(SemanticsProperties.Error, nameTooLong))
            assertEquals(fieldBounds, editor.getUnclippedBoundsInRoot())
            assertEquals(saveBounds, save.getUnclippedBoundsInRoot())
            assertTrue(writes.isEmpty())
            editor.performTextReplacement("  Field notes  ")
            lengthError.assertDoesNotExist()
            assertEquals(saveBounds, save.getUnclippedBoundsInRoot())
            val beforeSave = System.currentTimeMillis()
            beforeSaveReads = reads.get()
            save.performClick()
            compose.waitUntil(10_000) { writes.size == 1 }
            val operationId = UUID.fromString(writes.first())
            val issuedAt = operationId.mostSignificantBits ushr 16
            assertEquals(7, operationId.version())
            assertEquals(2, operationId.variant())
            assertTrue(issuedAt in beforeSave..System.currentTimeMillis())
            editor.assertTextContains("  Field notes  ")
            val saving = compose.onNodeWithText(app.getString(R.string.settings_saving))
            assertEquals(saveBounds, saving.assertIsNotEnabled().getUnclippedBoundsInRoot())
            compose.onNodeWithText("Cancel").assertIsNotEnabled()
            assertEquals("Research", currentList()?.projects?.single()?.name)
        } finally {
            pending.countDown()
        }
        val failure = "Could not save. Your changes are still here."
        compose.waitUntilExactlyOneExists(hasText(failure), 10_000)
        editor.assertTextContains("  Field notes  ")
        editor.assert(SemanticsMatcher.expectValue(SemanticsProperties.Error, failure))
        save.assertIsEnabled()
        assertEquals(beforeSaveReads, reads.get())
        assertEquals("Research", currentList()?.projects?.single()?.name)
        committed.set(writes.single())
        refreshWorkspaceChats()
        compose.waitUntil(10_000) {
            currentList()?.projects?.singleOrNull()?.name == "Field notes"
        }
        editor.assertTextContains("  Field notes  ")
        save.assertIsNotEnabled()
        compose.onNodeWithText(failure).assertDoesNotExist()
        compose.onNodeWithText("Project name saved").assertDoesNotExist()
        assertEquals(1, writes.size)
        compose.onNodeWithText("Cancel").performClick()
        editor.assertDoesNotExist()
        compose.onNodeWithText("Field notes").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun rejectedProjectRenameShowsFailureAtTheProjectWithoutDisplacingUndo() {
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        val renameStarted = AtomicBoolean()
        val releaseRename = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                    events.add(25L to request.rowEvent(25, CHAT_PERSONAL, "unarchived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/projects/$CHAT_PROJECT" -> {
                    renameStarted.set(true)
                    releaseRename.await()
                    MockResponse().setResponseCode(409)
                }
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val rowTag = "chat_$CHAT_PERSONAL"
        val chat = compose.onNodeWithTag(rowTag)
        try {
            compose.runOnIdle {
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready,
                    )
                    .chats
                    .renameProject(CHAT_PROJECT, "Field notes")
            }
            compose.waitUntil(10_000) { renameStarted.get() }
            compose.onNodeWithText("Research").assertIsDisplayed()

            compose.onNodeWithTag("chat_list").performScrollToNode(hasTestTag(rowTag))
            chat.performTouchInput { swipe(center.copy(x = width * 0.8f), center) }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Chat archived").fetchSemanticsNodes().isNotEmpty()
            }
        } finally {
            releaseRename.countDown()
        }
        val failure = "Could not rename the Project."
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(failure).fetchSemanticsNodes().isNotEmpty()
        }
        val project = compose.onNodeWithText("Research").assertIsDisplayed()
        val inList = hasAnyAncestor(hasTestTag("chat_list"))
        val notice = compose.onNode(hasText(failure).and(inList)).assertIsDisplayed()
        assertTrue(
            notice.getUnclippedBoundsInRoot().top >= project.getUnclippedBoundsInRoot().bottom,
        )
        compose.onNodeWithText("Try again").assertDoesNotExist()
        val undo = compose.onNodeWithText("Undo").assertIsDisplayed().assertIsEnabled()
        compose.onNode(hasContentDescription("Dismiss").and(inList)).performClick()
        compose.onNodeWithText(failure).assertDoesNotExist()

        undo.performClick()
        awaitRowActionSettled(CHAT_PERSONAL)
        chat.assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun keyboardMoveFocusesTheCollapsedDestinationWithoutOpeningIt() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        app.fixture.commandResponse = { request ->
            if (
                request.method == "PUT" &&
                    request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL/project"
            ) {
                val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                val eventId = body.getValue("eventId").jsonPrimitive.content
                assertEquals(CHAT_PROJECT, body.getValue("projectId").jsonPrimitive.content)
                events +=
                    24L to
                        chatEventWire(
                            id = eventId,
                            seq = 24,
                            kind = "project_updated",
                            extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                        )
                jsonResponse("""{"threadId":"$CHAT_PERSONAL","projectId":"$CHAT_PROJECT"}""")
            } else null
        }
        app.responseGate.countDown()
        awaitListAndNames()

        val row = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        row.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        row.performKeyInput { pressKey(Key.Menu) }
        val move = compose.onNodeWithText("Move to Research")
        move.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        move.performKeyInput { pressKey(Key.Enter) }

        compose.waitUntil(10_000) {
            currentList()?.threads?.singleOrNull { it.id == CHAT_PERSONAL }?.projectId ==
                CHAT_PROJECT
        }
        compose.onNodeWithText("Research").assertIsFocused()
        row.assertDoesNotExist()
        compose.onNodeWithText("Project chat").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun unknownProjectDeletionUsesTheReservedConfirmationStatus() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        val deletes = AtomicInteger()
        val releaseDelete = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            if (
                request.method == "DELETE" &&
                    request.requestUrl?.encodedPath == "/api/projects/$CHAT_PROJECT"
            ) {
                deletes.incrementAndGet()
                releaseDelete.await()
                MockResponse().setResponseCode(503)
            } else null
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val projectRow = compose.onNodeWithText("Research")
        projectRow.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        projectRow.performKeyInput { pressKey(Key.Menu) }
        compose.onNodeWithText("Delete Project").performClick()
        compose.onNodeWithText("Delete Project?").assertIsDisplayed()
        compose
            .onNode(hasText("Research", substring = true).and(hasAnyAncestor(isDialog())))
            .assertIsDisplayed()
        assertEquals(0, deletes.get())
        val confirm = compose.onNodeWithText("Delete Project")
        val confirmBounds = confirm.getUnclippedBoundsInRoot()
        val politeStatus =
            SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite)
        try {
            confirm.assertIsEnabled().performClick()
            compose.waitUntil(10_000) { deletes.get() == 1 }
            val pending =
                compose.onNodeWithText("Deleting…").assertIsNotEnabled().assert(politeStatus)
            assertEquals(confirmBounds, pending.getUnclippedBoundsInRoot())
            compose.onNodeWithText("Cancel").assertIsEnabled()
        } finally {
            releaseDelete.countDown()
        }
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Could not delete the Project.")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithText("Delete Project?").assertIsDisplayed()
        val failure = compose.onNodeWithText("Could not delete the Project.").assert(politeStatus)
        assertTrue(failure.getUnclippedBoundsInRoot().bottom < confirmBounds.top)
        confirm.assertIsEnabled()
        assertEquals(confirmBounds, confirm.getUnclippedBoundsInRoot())
        assertEquals(1, deletes.get())
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Delete Project?").assertDoesNotExist()
        projectRow.assertIsFocused()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun unknownProjectDeletionDoesNotReplayFeedbackAfterLeavingTheList() {
        val app = compose.activity.application as ChatListApplication
        val deleteStarted = CountDownLatch(1)
        val releaseDelete = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            if (
                request.method == "DELETE" &&
                    request.requestUrl?.encodedPath == "/api/projects/$CHAT_PROJECT"
            ) {
                deleteStarted.countDown()
                releaseDelete.await()
                MockResponse().setResponseCode(503)
            } else null
        }
        app.responseGate.countDown()
        awaitListAndNames()
        try {
            compose.onNodeWithText("Research").performTouchInput { longClick() }
            compose.onNodeWithText("Delete Project").performClick()
            compose.onNodeWithText("Delete Project").performClick()
            compose.waitUntil(10_000) { deleteStarted.count == 0L }
            compose.onNodeWithText("Cancel").performClick()
            compose.onNodeWithTag("chat_$CHAT_PERSONAL").performClick()
            compose.onNodeWithTag("chat_list").assertDoesNotExist()

            releaseDelete.countDown()
            compose.waitUntil(10_000) {
                currentList()?.let { it.projectList.deletingId == null } == true
            }
            val failure = "Could not delete the Project."
            compose.onNodeWithText(failure).assertDoesNotExist()

            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithText("Research").assertIsDisplayed()
            compose.onNodeWithText(failure).assertDoesNotExist()
        } finally {
            releaseDelete.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun movingAChatPreservesAQueuedProjectDeletionError() {
        val app = compose.activity.application as ChatListApplication
        val releaseDelete = CountDownLatch(1)
        val deleteStarted = CountDownLatch(1)
        val events = app.fixture.rowEventTail()
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/projects/$CHAT_PROJECT" -> {
                    deleteStarted.countDown()
                    releaseDelete.await()
                    MockResponse().setResponseCode(409)
                }
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> MockResponse().setResponseCode(400)
                "/api/chat-threads/$CHAT_PERSONAL/project" -> {
                    val eventId =
                        request.jsonCommandBody().getValue("eventId").jsonPrimitive.content
                    events +=
                        24L to
                            chatEventWire(
                                id = eventId,
                                seq = 24,
                                kind = "project_updated",
                                extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                            )
                    jsonResponse("""{"threadId":"$CHAT_PERSONAL","projectId":"$CHAT_PROJECT"}""")
                }
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val inListFeedback = hasAnyAncestor(hasTestTag("chat_list_feedback"))
        val archiveError = hasText("Could not complete “Archive chat”.") and inListFeedback
        val projectError = hasText("Could not delete the Project.") and inListFeedback
        val personal = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        try {
            compose.onNodeWithText("Research").performTouchInput { longClick() }
            compose.onNodeWithText("Delete Project").performClick()
            compose.onNodeWithText("Delete Project").performClick()
            compose.waitUntil(10_000) { deleteStarted.count == 0L }
            compose.onNodeWithText("Cancel").performClick()

            personal.performTouchInput { longClick() }
            compose.onNodeWithText("Archive chat").performClick()
            compose.waitUntilExactlyOneExists(archiveError, 10_000)

            releaseDelete.countDown()
            compose.waitUntil(10_000) {
                val list = currentList()
                list?.projectList?.deletingId == null &&
                    list?.projectDeleteFeedback?.singleOrNull()?.status ==
                        ProjectDeleteStatus.Rejected
            }
            compose.onNode(archiveError).assertIsDisplayed()
            compose.onNode(projectError).assertDoesNotExist()
            personal.performTouchInput { longClick() }
            compose.onNodeWithText("Move to Research").performClick()
            compose.waitUntil(10_000) {
                currentList()?.threads?.singleOrNull { it.id == CHAT_PERSONAL }?.projectId ==
                    CHAT_PROJECT
            }

            compose.mainClock.advanceTimeBy(FEEDBACK_TIMEOUT_MILLIS)
            compose.onNode(projectError).assertIsDisplayed()
        } finally {
            releaseDelete.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun projectDeletionReportsRegroupingAfterTheChatFeedRecovers() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val deletionId = AtomicReference<String>()
        val chatReadAvailable = AtomicBoolean(false)
        val events = fixture.rowEventTail()
        val readChatEvents = fixture.events
        fixture.events = { request ->
            if (deletionId.get() != null && !chatReadAvailable.get())
                MockResponse().setResponseCode(503)
            else readChatEvents(request)
        }
        fixture.projectEvents = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
            val id = deletionId.get()
            val tail =
                if (id == null || since >= 1) ""
                else
                    """{"id":"$id","seqId":1,"projectId":"$CHAT_PROJECT","kind":"deleted","name":null,"createdAt":"$CHAT_DATE"}"""
            jsonResponse("""{"events":[$tail],"hasMore":false}""")
        }
        fixture.commandResponse = { request ->
            if (
                request.method == "DELETE" &&
                    request.requestUrl?.encodedPath == "/api/projects/$CHAT_PROJECT"
            ) {
                events +=
                    24L to
                        chatEventWire(
                            id = "00000024-0000-4000-8000-000000000000",
                            seq = 24,
                            thread = CHAT_IN_PROJECT,
                            kind = "project_updated",
                            extra = ",\"projectId\":null",
                        )
                deletionId.set(request.jsonCommandBody().getValue("eventId").jsonPrimitive.content)
                MockResponse().setResponseCode(204)
            } else null
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Research").performTouchInput { longClick() }
        compose.onNodeWithText("Delete Project").performClick()
        compose.onNodeWithText("Delete Project?").assertIsDisplayed()
        compose.onNodeWithText("Delete Project").performClick()

        compose.waitUntil(10_000) {
            val state = currentList() ?: return@waitUntil false
            state.projects.isEmpty() && state.projectList.deletingId == null
        }
        val deletionMessage = "Project deleted and its chats moved outside Projects."
        assertEquals(
            CHAT_PROJECT,
            currentList()?.threads?.single { it.id == CHAT_IN_PROJECT }?.projectId,
        )
        compose.onNodeWithText("Project chat").assertIsDisplayed()
        compose.onNodeWithText(deletionMessage).assertDoesNotExist()

        chatReadAvailable.set(true)
        refreshWorkspaceChats()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(deletionMessage).fetchSemanticsNodes().isNotEmpty()
        }
        assertNull(
            checkNotNull(currentList()).threads.single { it.id == CHAT_IN_PROJECT }.projectId,
        )
        compose.onNodeWithText(deletionMessage).assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    fun projectPinMoveRestoresTheFailedRankAndAcceptsItsLateEvent() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val neighbor = "99999999-9999-4999-8999-999999999999"
        val outside = "18888888-8888-4888-8888-888888888888"
        fun seed(seq: Long, id: String, title: String, rank: String, project: Boolean) =
            listOf(
                chatEventWire(
                    id = "00000000-0000-4000-8000-${seq.toString().padStart(12, '0')}",
                    seq = seq,
                    thread = id,
                    title = title,
                    extra = if (project) ",\"projectId\":\"$CHAT_PROJECT\"" else "",
                ),
                chatEventWire(
                    id = "00000000-0000-4000-8000-${(seq + 1).toString().padStart(12, '0')}",
                    seq = seq + 1,
                    thread = id,
                    kind = "pinned",
                    extra = ",\"pinOrder\":\"$rank\"",
                ),
            )
        val initial =
            seed(17, CHAT_PERSONAL, "First Project pin", "a0", true) +
                seed(19, neighbor, "Neighbor pin", "a1", true) +
                seed(21, CHAT_IN_PROJECT, "Tied Project pin", "a1", true) +
                seed(23, outside, "Outside pin", "a1", false)
        fixture.events = {
            jsonResponse("""{"events":[${initial.joinToString(",")}],"hasMore":false}""")
        }
        val events = fixture.rowEventTail()
        val rejectMoved = AtomicBoolean(true)
        val commands = CopyOnWriteArrayList<RecordedRequest>()
        fixture.commandResponse = { request ->
            val url = request.requestUrl
            if (request.method != "POST" || url?.pathSegments?.lastOrNull() != "pin-order") null
            else {
                val id = url.pathSegments[2]
                commands.add(request)
                if (id == CHAT_PERSONAL && rejectMoved.get()) MockResponse().setResponseCode(503)
                else {
                    val seq = 24L + commands.size
                    val body = request.jsonCommandBody()
                    events.add(
                        seq to
                            chatEventWire(
                                id = body.getValue("eventId").jsonPrimitive.content,
                                seq = seq,
                                thread = id,
                                kind = "sort_touched",
                                extra = ",\"pinOrder\":${body.getValue("pinOrder")}",
                            ),
                    )
                    MockResponse().setResponseCode(204)
                }
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        setResearchExpanded(true)
        val first = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        val target = compose.onNodeWithTag("chat_$neighbor")
        fun moveDown() {
            first.performSemanticsAction(SemanticsActions.OnLongClick)
            compose.onNodeWithText("Move up").assertDoesNotExist()
            compose.onNodeWithText("Move down").performClick()
        }
        val failedMove = "Could not complete “Move down”."
        moveDown()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(failedMove).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Refresh chats").assertDoesNotExist()
        assertTrue(
            first.fetchSemanticsNode().boundsInRoot.top <
                target.fetchSemanticsNode().boundsInRoot.top,
        )
        assertEquals(2, commands.size)
        val lost = commands.last().jsonCommandBody()
        events.add(
            26L to
                chatEventWire(
                    id = lost.getValue("eventId").jsonPrimitive.content,
                    seq = 26,
                    kind = "sort_touched",
                    extra = ",\"pinOrder\":${lost.getValue("pinOrder")}",
                ),
        )
        refreshWorkspaceChats()
        compose.waitUntil(10_000) {
            currentList()?.confirmedThreads?.single { it.id == CHAT_PERSONAL }?.pinOrder == "a2"
        }
        compose.mainClock.advanceTimeBy(FEEDBACK_TIMEOUT_MILLIS)
        compose.onNodeWithText(failedMove).assertDoesNotExist()
        rejectMoved.set(false)
        first.performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("Move up").performClick()
        awaitRowActionSettled(CHAT_PERSONAL)
        compose.waitUntil(10_000) {
            first.fetchSemanticsNode().boundsInRoot.top <
                target.fetchSemanticsNode().boundsInRoot.top
        }
        val tied = compose.onNodeWithTag("chat_$CHAT_IN_PROJECT")
        assertTrue(
            first.fetchSemanticsNode().boundsInRoot.top <
                tied.fetchSemanticsNode().boundsInRoot.top,
        )
        assertEquals(
            listOf(CHAT_IN_PROJECT to "a3", CHAT_PERSONAL to "a2", CHAT_PERSONAL to "a0"),
            commands.map { command ->
                command.requestUrl?.pathSegments?.get(2) to
                    command.jsonCommandBody().getValue("pinOrder").jsonPrimitive.content
            },
        )
        assertEquals(
            3,
            commands
                .map { it.jsonCommandBody().getValue("eventId").jsonPrimitive.content }
                .toSet()
                .size,
        )
    }
}
