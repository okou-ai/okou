package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.ComposerPersistence
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.TextDisposition
import android.os.Looper
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowSystemClock

class ChatConnectorRootApplication : TestOkouApplication() {
    internal lateinit var connectors: ConnectorApiFixture
    internal lateinit var chats: ComposerApiFixture

    override fun onCreate() {
        connectors = ConnectorApiFixture()
        chats = ComposerApiFixture()
        connectorService = connectors.service
        chatService = chats.service
        composerService = chats.service
        journalStore =
            ComposerJournalStore(
                this,
                noBackupFilesDir.resolve("chat-options-${UUID.randomUUID()}"),
            )
        super.onCreate()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w412dp-h892dp",
    application = ChatConnectorRootApplication::class,
)
class ChatConnectorOptionsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app
        get() = compose.activity.application as ChatConnectorRootApplication

    private val primaryTag = "chat-connector-selection-$CONNECTOR_CALENDAR_PRIMARY"
    private val repairTag = "chat-connector-repair-$CONNECTOR_CALENDAR_SECONDARY"
    private val calendarTag = "chat-connector-service-$CONNECTOR_CALENDAR"

    @After
    fun close() {
        val application = app
        application.connectors.overviewReplyGate?.countDown()
        application.connectors.chatOverrideReplyGate?.countDown()
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
            application.connectors.use {
                application.chats.use {
                    runBlocking { checkNotNull(application.journalStore).close() }
                }
            }
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun existingChatShowsThePendingChoiceAndPublishesTheReceipt() {
        waitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
        openPicker()
        val account = compose.onNodeWithTag(primaryTag)
        val frame = compose.onNodeWithTag("connector-sheet").getUnclippedBoundsInRoot()
        val row = account.getUnclippedBoundsInRoot()
        assertEquals(460.dp, frame.right - frame.left)
        assertTrue(row.bottom - row.top >= 72.dp)
        val pending = CountDownLatch(1)
        app.connectors.chatOverrideReplyGate = pending
        try {
            account.assertIsOn().performClick()
            compose.waitUntil(10_000) { app.connectors.chatOverrideRequests.size == 1 }
            account.assertIsOff().assertIsNotEnabled()
        } finally {
            pending.countDown()
        }
        waitTag("chat-connector-reset")
        account.assertIsOff()
        assertEquals(
            FixtureChatOverride(
                CHAT_PERSONAL,
                CONNECTOR_CALENDAR,
                CONNECTOR_CALENDAR_PRIMARY,
                false,
            ),
            app.connectors.chatOverrideRequests.single(),
        )
        assertEquals(null, app.connectors.chatOverride(CHAT_IN_PROJECT, CONNECTOR_CALENDAR_PRIMARY))

        app.connectors.rejectChatOverride = 403
        account.performClick()
        waitText("Could not save the connector choice.")
        account.assertIsOff()
        val failure =
            compose
                .onNodeWithText("Could not save the connector choice.")
                .getUnclippedBoundsInRoot()
        assertEquals(8.dp, failure.top - account.getUnclippedBoundsInRoot().bottom)

        app.connectors.rejectChatOverride = null
        compose.onNodeWithTag("chat-connector-reset").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("chat-connector-reset").fetchSemanticsNodes().isEmpty()
        }
        account.assertIsOn()
        assertEquals(null, app.connectors.chatOverride(CHAT_PERSONAL, CONNECTOR_CALENDAR_PRIMARY))
    }

    @Test
    fun existingChatRestoresSendAndUsesLaterNormalSyncAfterALostChoiceReceipt() {
        waitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
        waitForComposer()
        val draft = compose.onNodeWithTag("message_input")
        draft.performTextReplacement("Read my calendar")
        val send = compose.onNodeWithContentDescription("Send").assertIsEnabled()
        openPicker()
        val account = compose.onNodeWithTag(primaryTag)
        val reply = CountDownLatch(1)
        app.connectors.loseChatOverrideReply = true
        app.connectors.chatOverrideReplyGate = reply
        try {
            account.assertIsOn().performClick()
            waitText("Saving connector choice…")
            account.assertIsOff().assertIsNotEnabled()
            compose.waitUntil(10_000) { app.connectors.chatOverrideRequests.size == 1 }
            assertTrue(
                compose.runOnIdle { connectorOptions().blocksSend(ComposerTarget(CHAT_PERSONAL)) },
            )
            assertTrue(app.chats.inputs.isEmpty())
        } finally {
            reply.countDown()
        }
        waitText("Could not save the connector choice.")
        account.assertIsOn().assertIsEnabled()
        closeOptions()
        send.assertIsEnabled()
        draft.assertTextContains("Read my calendar")

        openPicker()
        waitTag("chat-connector-reset")
        account.assertIsOff().assertIsEnabled()
        assertTrue(app.connectors.chatOverrideReads.isEmpty())
        assertEquals(1, app.connectors.chatOverrideRequests.size)
        assertTrue(app.chats.inputs.isEmpty())
    }

    @Test
    fun coldConnectorReadsShowTheSharedFailureIllustrationOnBothLevels() {
        openNewChat()
        app.connectors.failChatOverview = true
        openOverview(waitForRows = false)
        waitText("Temporarily unable to load")
        compose
            .onNodeWithTag("content-read-failure-illustration", useUnmergedTree = true)
            .assertIsDisplayed()
        compose.onNodeWithTag("chat-connector-manage").assertIsDisplayed()
        val overviewRead = "/api/chat-connector-overview" to null
        assertEquals(3, app.connectors.chatConnectorReads.count { it == overviewRead })

        inSheet(hasContentDescription("Back")).performClick()
        dismissParentOptions()
        app.connectors.failChatOverview = false
        openOverview()
        app.connectors.failAccountReads = true
        app.connectors.accountRetryAfterSeconds = 0
        compose.onNodeWithTag(calendarTag).performClick()
        waitText("Temporarily unable to load")
        compose
            .onNodeWithTag("content-read-failure-illustration", useUnmergedTree = true)
            .assertIsDisplayed()
        inSheet(hasContentDescription("Back")).performClick()
        compose.onNodeWithTag(calendarTag).assertIsDisplayed()
        assertEquals(4, app.connectors.chatConnectorReads.count { it == overviewRead })
    }

    @Test
    fun warmOverviewRefreshFailureKeepsRowsAndClearsItsSnackbarOnRecovery() {
        openNewChat()
        openOverview()
        val lastService = compose.onNodeWithTag("chat-connector-service-slack")
        val footer = compose.onNodeWithTag("chat-connector-manage")
        val serviceBounds = lastService.getUnclippedBoundsInRoot()
        val footerBounds = footer.getUnclippedBoundsInRoot()
        app.connectors.failChatOverview = true
        inSheet(hasContentDescription("Back")).performClick()
        dismissParentOptions()
        openOverview()
        val message = "Could not refresh connectors."
        waitText(message)
        val snackbar = compose.onNodeWithText(message).assertIsDisplayed()
        compose.onNodeWithTag(calendarTag).assertIsDisplayed()
        lastService.assertIsDisplayed()
        footer.assertIsDisplayed()
        assertEquals(serviceBounds, lastService.getUnclippedBoundsInRoot())
        assertEquals(footerBounds, footer.getUnclippedBoundsInRoot())
        assertTrue(serviceBounds.bottom <= snackbar.getUnclippedBoundsInRoot().top)
        val overviewRead = "/api/chat-connector-overview" to null
        assertEquals(4, app.connectors.chatConnectorReads.count { it == overviewRead })

        inSheet(hasContentDescription("Back")).performClick()
        dismissParentOptions()
        app.connectors.failChatOverview = false
        val recovered = app.connectors.chatConnectorReads.size + 1
        openOverview()
        compose.waitUntil(10_000) {
            app.connectors.chatConnectorReads.size == recovered &&
                compose.onAllNodesWithText(message).fetchSemanticsNodes().isEmpty()
        }
        compose.onNodeWithTag(calendarTag).assertIsDisplayed()
        assertEquals(5, app.connectors.chatConnectorReads.count { it == overviewRead })
    }

    @Test
    @Config(qualifiers = "en-rUS-w240dp-h680dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun confirmedEmptyOverviewKeepsItsBoundsWhenRefreshFeedbackAppears() {
        val fontScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            openNewChat()
            app.connectors.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
            app.connectors.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
            app.connectors.removeAccount(CONNECTOR_SLACK_ACCOUNT)
            openOverview(waitForRows = false)
            val empty = "There are no connected accounts in this workspace."
            waitText(empty)
            val footer = compose.onNodeWithTag("chat-connector-manage")
            val before = footer.getUnclippedBoundsInRoot()

            app.connectors.failChatOverview = true
            compose.runOnIdle { connectorOptions().invalidate("slack") }
            val message = "Could not refresh connectors."
            waitText(message)
            val layouts = mutableListOf<TextLayoutResult>()
            compose.onNodeWithText(message).assertIsDisplayed().performSemanticsAction(
                SemanticsActions.GetTextLayoutResult,
            ) {
                it(layouts)
            }
            val layout = layouts.single()
            assertTrue(layout.lineCount > 2)
            assertTrue(!layout.hasVisualOverflow)
            compose.onNodeWithText(empty).assertIsDisplayed()
            assertEquals(before, footer.getUnclippedBoundsInRoot())
        } finally {
            RuntimeEnvironment.setFontScale(fontScale)
        }
    }

    @Test
    fun openingRefreshesTheWarmOverviewAndBackReusesBothReadScopes() {
        openNewChat()
        val overview = "/api/chat-connector-overview" to null
        val held = CountDownLatch(1)
        app.connectors.overviewReplyGate = held
        try {
            openOverview(waitForRows = false)
            compose.waitUntil(10_000) { app.connectors.chatConnectorReads.contains(overview) }
            inSheet(hasContentDescription("Back")).performClick()
            dismissParentOptions()
            openOverview(waitForRows = false)
            assertEquals(listOf(overview), app.connectors.chatConnectorReads.toList())
        } finally {
            held.countDown()
        }
        waitTag(calendarTag)
        assertEquals(listOf(overview), app.connectors.chatConnectorReads.toList())
        compose.onNodeWithTag("chat-connector-service-slack").assertExists()
        val row = compose.onNodeWithTag(calendarTag).getUnclippedBoundsInRoot()
        assertEquals(56.dp, row.bottom - row.top)
        inSheet(hasContentDescription("Back")).performClick()
        dismissParentOptions()
        val warmReply = CountDownLatch(1)
        app.connectors.overviewReplyGate = warmReply
        try {
            openOverview()
            compose.waitUntil(10_000) {
                app.connectors.chatConnectorReads.count { it == overview } == 2
            }
            compose.onNodeWithTag("chat-connector-service-slack").assertIsDisplayed()
            compose.onNodeWithTag(calendarTag).performClick()
            waitTag(primaryTag)
            app.connectors.removeAccount(CONNECTOR_SLACK_ACCOUNT)
        } finally {
            warmReply.countDown()
        }
        val expected =
            listOf(
                overview,
                overview,
                "/api/connector-accounts/connections" to CONNECTOR_CALENDAR,
                "/api/feature-switches" to null,
            )
        assertEquals(expected.toSet(), app.connectors.chatConnectorReads.toSet())
        assertEquals(expected.size, app.connectors.chatConnectorReads.size)
        inSheet(hasContentDescription("Back")).performClick()
        waitTag(calendarTag)
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithTag("chat-connector-service-slack")
                .fetchSemanticsNodes()
                .isEmpty()
        }
        compose.onNodeWithTag(calendarTag).assertIsFocused().performClick()
        waitTag(primaryTag)
        assertEquals(expected.size, app.connectors.chatConnectorReads.size)

        compose.runOnIdle { ShadowSystemClock.simulateDeepSleep(Duration.ofMinutes(10)) }
        compose.onNodeWithTag(primaryTag).assertIsDisplayed()
        inSheet(hasContentDescription("Back")).performClick()
        waitTag(calendarTag)
        compose.onNodeWithTag(calendarTag).performClick()
        val accounts = "/api/connector-accounts/connections" to CONNECTOR_CALENDAR
        compose.waitUntil(10_000) {
            app.connectors.chatConnectorReads.count { it == accounts } == 2
        }
        waitTag(primaryTag)
    }

    @Test
    fun aPolicyReadFailureLeavesTheSelectedServiceAndRepairVisible() {
        app.connectors.memberAccess = true
        app.connectors.denyPolicyReads = true
        openNewChat()
        openOverview()
        assertEquals(
            listOf("/api/chat-connector-overview" to null),
            app.connectors.chatConnectorReads.toList(),
        )
        compose.onNodeWithTag(calendarTag).performClick()
        waitTag(repairTag)
        waitText("Could not load access policies.")
        compose.onNodeWithText("calendar@example.com").assertIsDisplayed()
        compose.onNodeWithTag(repairTag).assertIsDisplayed()
        assertEquals(
            listOf("/api/connector-account-access/policies" to CONNECTOR_CALENDAR),
            app.connectors.chatConnectorReads.filter { it.first.endsWith("/policies") },
        )
    }

    @Test
    fun unhealthyRowOpensTheExactAccountAndRetainsTheDraftAndCursor() {
        openNewChat()
        val input = compose.onNodeWithTag("message_input")
        input.performClick().assertIsFocused()
        input.performTextReplacement("Review the release calendar")
        input.performTextInputSelection(TextRange(11))
        openPicker()
        compose.onNodeWithTag(primaryTag).assertIsOn().performClick()
        compose.onNodeWithTag(primaryTag).assertIsOff()
        compose.onNodeWithTag(repairTag).performClick()
        waitText("Update permissions")
        inSheet(hasText("team@example.com")).assertExists()

        backToComposer()
        input.assertTextContains("Review the release calendar").assertIsFocused()
        assertEquals(
            TextRange(11),
            input.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        assertTrue(app.connectors.chatOverrideRequests.isEmpty())
        assertTrue(app.chats.inputs.isEmpty())
    }

    @Test
    fun firstSendSkipsDraftOverridesAfterMemberAccessIsEnabled() {
        openNewChat()
        compose.onNodeWithTag("message_input").performTextReplacement("Read the calendar")
        openPicker()
        compose.onNodeWithTag(primaryTag).assertIsOn().performClick()
        closeOptions()

        app.connectors.memberAccess = true
        compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
        compose.waitUntil(10_000) { app.chats.inputs.size == 1 }
        assertEquals(1, app.chats.created.size)
        assertTrue(app.connectors.chatOverrideRequests.isEmpty())
    }

    @Test
    fun failedFirstSendSetupCanBeRevisedBeforeRetryingTheSameInput() {
        openNewChat()
        val input = compose.onNodeWithTag("message_input")
        input.performTextReplacement("Summarize the release schedule")
        openPicker()
        compose.onNodeWithTag(primaryTag).performClick()
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                composer().uiState.value.persistence == ComposerPersistence.Durable
            }
        }
        compose.activityRule.scenario.recreate()
        waitTag(primaryTag)
        compose.onNodeWithTag(primaryTag).assertIsOff()
        closeOptions()

        app.connectors.rejectChatOverride = 503
        compose.onNodeWithContentDescription("Send").performClick()
        waitText(
            "Could not apply the connector choices. Review them in Chat options, then retry this message.",
        )
        val pending = compose.runOnIdle {
            checkNotNull(composer().uiState.value.entry(ComposerTarget()).pending)
        }
        assertTrue(app.chats.inputs.isEmpty())
        assertEquals(
            pending.threadId,
            app.chats.created.single().getValue("clientThreadId").jsonPrimitive.content,
        )
        assertEquals(false, app.connectors.chatOverrideRequests.single().enabled)
        assertTrue(app.connectors.chatOverrideReads.isEmpty())

        app.connectors.rejectChatOverride = null
        openPicker()
        compose.onNodeWithTag("chat-connector-reset").performClick()
        compose.onNodeWithTag(primaryTag).assertIsOn()
        closeOptions()
        compose
            .onNodeWithText("Retry this same message")
            .performScrollTo()
            .assertIsDisplayed()
            .assertIsEnabled()
            .performClick()
        compose.waitUntil(10_000) {
            compose.runOnIdle { app.chats.inputs.containsKey(pending.eventId) }
        }
        assertEquals(1, app.chats.created.size)
        assertEquals(1, app.chats.inputs.size)
        assertEquals(pending.threadId, app.connectors.chatOverrideRequests.last().threadId)
        assertEquals(null, app.connectors.chatOverrideRequests.last().enabled)
        assertEquals(
            "Summarize the release schedule",
            app.chats.inputs.getValue(pending.eventId).getValue("prompt").jsonPrimitive.content,
        )
    }

    @Test
    fun rejectedChatCreationRestoresTheDraftConnectorChoices() {
        openNewChat()
        val message = "Summarize the saved calendar"
        val field = compose.onNodeWithTag("message_input")
        field.performTextReplacement(message)
        openPicker()
        compose.onNodeWithTag(primaryTag).assertIsOn().performClick()
        closeOptions()

        app.chats.rejectCreate = true
        compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
        val restore = "Restore retained draft"
        waitText(restore)
        assertTrue(app.chats.created.isEmpty())
        assertTrue(app.connectors.chatOverrideRequests.isEmpty())
        compose.onNodeWithText(restore).performScrollTo().performClick()
        field.assertTextContains(message)
        openPicker()
        compose.onNodeWithTag(primaryTag).assertIsOff()
        closeOptions()

        app.chats.rejectCreate = false
        compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
        compose.waitUntil(10_000) { app.chats.inputs.size == 1 }
        assertEquals(false, app.connectors.chatOverrideRequests.single().enabled)
        assertEquals(
            message,
            app.chats.inputs.values.single().getValue("prompt").jsonPrimitive.content,
        )
    }

    @Test
    fun projectSendConfirmsTheAccountAndRecoversTheOriginalInputWithoutRewriting() {
        openNewChat()
        val message = "Summarize the Project calendar"
        val field = compose.onNodeWithTag("message_input")
        field.performTextReplacement(message)
        openPicker()
        compose.onNodeWithTag(primaryTag).assertIsOn().performClick()
        closeOptions()
        compose.onNodeWithContentDescription("Back").performClick()

        waitText("Research")
        compose.onNodeWithText("Research").performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("New chat in this Project").performClick()
        waitForComposer()
        field.assertTextContains(message)
        openPicker()
        compose.onNodeWithTag(primaryTag).assertIsOff()
        closeOptions()

        val application = app
        val observedAtSend = AtomicReference<Boolean?>()
        application.chats.beforeSendReturn = {
            val thread =
                application.chats.created.single().getValue("clientThreadId").jsonPrimitive.content
            observedAtSend.set(
                application.connectors.chatOverride(thread, CONNECTOR_CALENDAR_PRIMARY),
            )
        }
        val reply = CountDownLatch(1)
        application.connectors.chatOverrideReplyGate = reply
        application.chats.disconnectSend = true
        application.chats.inputDisposition = "queued"
        try {
            compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
            compose.waitUntil(10_000) {
                compose.runOnIdle { application.connectors.chatOverrideRequests.size == 1 }
            }
            assertTrue(application.chats.inputs.isEmpty())
        } finally {
            reply.countDown()
        }

        compose.waitUntil(10_000) {
            compose.runOnIdle { application.chats.inputs.size == 1 && observedAtSend.get() != null }
        }
        val chat = app.chats.created.single()
        assertEquals(CHAT_PROJECT, chat.getValue("projectId").jsonPrimitive.content)
        assertEquals(false, observedAtSend.get())
        val thread = chat.getValue("clientThreadId").jsonPrimitive.content
        val event = application.chats.inputs.keys.single()
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                val receipt =
                    composer().uiState.value.entry(ComposerTarget(threadId = thread)).receipt
                receipt?.eventId == event && receipt.disposition == TextDisposition.Queued
            }
        }
        assertEquals(
            1,
            application.chats.requests.count {
                it.method == "POST" && it.requestUrl?.encodedPath == "/api/chat/events"
            },
        )
        assertEquals(thread, app.connectors.chatOverrideRequests.single().threadId)
        assertTrue(app.connectors.chatOverrideReads.isEmpty())
    }

    private fun composer() =
        checkNotNull(
                ViewModelProvider(compose.activity)[SessionModel::class.java].uiState.value.ready,
            )
            .composer

    private fun connectorOptions() =
        checkNotNull(
                ViewModelProvider(compose.activity)[SessionModel::class.java]
                    .uiState
                    .value
                    .ready
                    ?.connectors,
            )
            .chatOptions

    private fun openNewChat() {
        waitText("New chat")
        compose.onNodeWithText("New chat").performClick()
        waitForComposer()
    }

    private fun waitForComposer() {
        waitTag("message_input")
        compose.waitUntil(10_000) { compose.runOnIdle { composer().uiState.value.journal != null } }
    }

    private fun openPicker() {
        openOverview()
        compose.onNodeWithTag(calendarTag).performClick()
        waitTag(primaryTag)
    }

    private fun openOverview(waitForRows: Boolean = true) {
        waitTag("chat-options-button")
        val options = compose.onNodeWithTag("chat-options-button")
        val bounds = options.getUnclippedBoundsInRoot()
        assertEquals(48.dp, bounds.bottom - bounds.top)
        options.performClick()
        compose.onNodeWithTag("chat-options-connectors").performClick()
        waitTag(if (waitForRows) calendarTag else "chat-connector-manage")
    }

    private fun backToComposer() {
        inSheet(hasContentDescription("Back")).performClick()
        waitTag(primaryTag)
        compose.onNodeWithTag(primaryTag).assertIsOff()
        closeOptions()
    }

    private fun closeOptions() {
        inSheet(hasContentDescription("Back")).performClick()
        waitTag(calendarTag)
        inSheet(hasContentDescription("Back")).performClick()
        dismissParentOptions()
    }

    private fun dismissParentOptions() {
        waitTag("chat-options-connectors")
        compose.onNodeWithTag("chat-options-connectors").assertIsDisplayed()
        dismissSheet()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("chat-options-connectors").fetchSemanticsNodes().isEmpty()
        }
    }

    private fun dismissSheet() {
        compose
            .onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
            .performSemanticsAction(SemanticsActions.Dismiss)
    }

    private fun inSheet(matcher: SemanticsMatcher) =
        compose.onNode(matcher and hasAnyAncestor(hasTestTag("connector-sheet")))

    private fun waitTag(tag: String) =
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
        }

    private fun waitText(label: String) =
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(label).fetchSemanticsNodes().isNotEmpty()
        }
}
