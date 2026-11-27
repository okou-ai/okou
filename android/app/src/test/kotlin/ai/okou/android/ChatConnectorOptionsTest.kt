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
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

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
        application.connectors.chatOverrideReplyGate?.countDown()
        application.connectors.chatOverrideReadReplyGate?.countDown()
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
    fun existingChatShowsThePendingChoiceAndReconcilesALostResponse() {
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
        app.connectors.loseChatOverrideReply = true
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

        app.connectors.loseChatOverrideReply = false
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
    fun existingChatBlocksSendUntilAnUnconfirmedChoiceIsChecked() {
        waitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
        waitForComposer()
        compose.onNodeWithTag("message_input").performTextReplacement("Read my calendar")
        val send = compose.onNodeWithContentDescription("Send").assertIsEnabled()
        openPicker()
        val account = compose.onNodeWithTag(primaryTag)
        val readback = CountDownLatch(1)
        app.connectors.loseChatOverrideReply = true
        app.connectors.failChatOverrideReads = true
        app.connectors.chatOverrideReadReplyGate = readback
        try {
            account.assertIsOn().performClick()
            waitText("Checking account…")
            account.assertIsOff().assertIsNotEnabled()
        } finally {
            readback.countDown()
        }
        waitText("The outcome is still unconfirmed.")
        account.assertIsOff().assertIsNotEnabled()
        assertEquals(listOf(CHAT_PERSONAL to CONNECTOR_CALENDAR), app.connectors.chatOverrideReads)
        closeOptions()
        send.assertIsNotEnabled()
        compose
            .onNodeWithText("Check the connector choice in Chat options before sending.")
            .assertIsDisplayed()

        app.connectors.failChatOverrideReads = false
        openPicker()
        compose.onNodeWithText("Check result").performClick()
        waitTag("chat-connector-reset")
        account.assertIsOff().assertIsEnabled()
        closeOptions()
        send.assertIsEnabled()
        assertEquals(
            List(2) { CHAT_PERSONAL to CONNECTOR_CALENDAR },
            app.connectors.chatOverrideReads,
        )
        assertEquals(1, app.connectors.chatOverrideRequests.size)
    }

    @Test
    fun anUnconfirmedChoiceFollowsItsChatAndCanBeCheckedAfterTheServiceIsRemoved() {
        waitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
        waitForComposer()
        compose.onNodeWithTag("message_input").performTextReplacement("Read my calendar")
        app.connectors.loseChatOverrideReply = true
        app.connectors.failChatOverrideReads = true
        openPicker()
        compose.onNodeWithTag(primaryTag).performClick()
        waitText("The outcome is still unconfirmed.")
        closeOptions()

        val back = compose.onNodeWithContentDescription("Back")
        val send = compose.onNodeWithContentDescription("Send")
        back.performClick()
        openNewChat()
        compose.onNodeWithTag("message_input").performTextReplacement("Another draft")
        send.assertIsEnabled()
        back.performClick()
        waitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
        waitForComposer()
        compose.onNodeWithTag("message_input").assertTextContains("Read my calendar")
        send.assertIsNotEnabled()

        app.connectors.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
        app.connectors.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
        app.connectors.failChatOverrideReads = false
        openOverview(waitForRows = false)
        waitTag("chat-connector-service-slack")
        compose.onNodeWithTag(calendarTag).assertDoesNotExist()
        compose.onNodeWithText("Check result").assertIsDisplayed().performClick()
        waitText("This account is no longer available.")
        inSheet(hasContentDescription("Back")).performClick()
        dismissParentOptions()

        send.assertIsEnabled()
        assertEquals(
            List(2) { CHAT_PERSONAL to CONNECTOR_CALENDAR },
            app.connectors.chatOverrideReads,
        )
        assertEquals(1, app.connectors.chatOverrideRequests.size)
    }

    @Test
    fun anUnchangedReadKeepsARestorePendingUntilTheAccountIsUnavailable() {
        waitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
        waitForComposer()
        compose.onNodeWithTag("message_input").performTextReplacement("Read my calendar")
        openPicker()
        val account = compose.onNodeWithTag(primaryTag)
        account.assertIsOn().performClick()
        waitTag("chat-connector-reset")
        app.connectors.rejectChatOverride = 503
        compose.onNodeWithTag("chat-connector-reset").performClick()
        waitText("The outcome is still unconfirmed.")

        val readback = CountDownLatch(1)
        app.connectors.chatOverrideReadReplyGate = readback
        try {
            val check = compose.onNodeWithText("Check result").assertIsEnabled()
            val readyBounds = check.getUnclippedBoundsInRoot()
            check.performClick()
            waitText("Checking account…")
            val checking = compose.onNodeWithText("Checking account…").assertIsNotEnabled()
            assertEquals(readyBounds, checking.getUnclippedBoundsInRoot())
        } finally {
            readback.countDown()
        }
        waitText("The outcome is still unconfirmed.")
        account.assertIsOn().assertIsNotEnabled()
        closeOptions()

        val send = compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        openPicker()
        app.connectors.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
        app.connectors.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
        compose.onNodeWithText("Check result").performClick()
        waitTag("chat-connector-manage")
        compose.onNodeWithText("This account is no longer available.").assertIsDisplayed()
        inSheet(hasContentDescription("Back")).performClick()
        dismissParentOptions()
        send.assertIsEnabled()
        assertEquals(
            List(3) { CHAT_PERSONAL to CONNECTOR_CALENDAR },
            app.connectors.chatOverrideReads,
        )
        assertEquals(listOf(false, null), app.connectors.chatOverrideRequests.map { it.enabled })
    }

    @Test
    fun checkingFromTheOverviewRefreshesTheListWhenAnAccountWasReplaced() {
        waitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
        openPicker()
        app.connectors.rejectChatOverride = 503
        compose.onNodeWithTag(primaryTag).performClick()
        waitText("The outcome is still unconfirmed.")
        inSheet(hasContentDescription("Back")).performClick()
        waitTag(calendarTag)

        val replacementId = "10000000-0000-4000-8000-000000000008"
        app.connectors.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
        app.connectors.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
        app.connectors.addCalendarAccount(replacementId)
        compose.onNodeWithText("Check result").performClick()
        waitText("This account is no longer available.")
        waitTag(calendarTag)
        compose.onNodeWithTag(calendarTag).performClick()
        waitTag("chat-connector-selection-$replacementId")
        compose.onNodeWithTag(primaryTag).assertDoesNotExist()
        compose.onNodeWithText("This account is no longer available.").assertDoesNotExist()
        val overviewRead = "/api/chat-connector-overview" to CHAT_PERSONAL
        val accountsRead = "/api/connector-accounts/connections" to CONNECTOR_CALENDAR
        assertEquals(2, app.connectors.chatConnectorReads.count { it == overviewRead })
        assertEquals(2, app.connectors.chatConnectorReads.count { it == accountsRead })
        assertEquals(
            List(2) { CHAT_PERSONAL to CONNECTOR_CALENDAR },
            app.connectors.chatOverrideReads,
        )
        assertEquals(1, app.connectors.chatOverrideRequests.size)
    }

    @Test
    fun reopeningAServiceThatReconnectedAfterReadbackShowsItsNewAccount() {
        waitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
        openPicker()
        app.connectors.rejectChatOverride = 503
        compose.onNodeWithTag(primaryTag).performClick()
        waitText("The outcome is still unconfirmed.")

        app.connectors.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
        app.connectors.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
        compose.onNodeWithText("Check result").performClick()
        waitTag("chat-connector-manage")
        compose.onNodeWithTag(calendarTag).assertDoesNotExist()

        val replacementId = "10000000-0000-4000-8000-000000000008"
        app.connectors.addCalendarAccount(replacementId)
        compose.runOnIdle {
            val workspace =
                ViewModelProvider(compose.activity)[SessionModel::class.java].uiState.value.ready
            checkNotNull(workspace?.connectors).chatOptions.invalidate("slack")
        }
        waitTag(calendarTag)
        compose.onNodeWithTag(calendarTag).performClick()
        waitTag("chat-connector-selection-$replacementId")
    }

    @Test
    fun overviewAndSelectedServiceUseSeparateCachedReads() {
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
        openOverview()
        assertEquals(listOf(overview), app.connectors.chatConnectorReads.toList())

        compose.onNodeWithTag(calendarTag).performClick()
        waitTag(primaryTag)
        val expected =
            listOf(
                overview,
                "/api/connector-accounts/connections" to CONNECTOR_CALENDAR,
                "/api/feature-switches" to null,
            )
        assertEquals(expected.toSet(), app.connectors.chatConnectorReads.toSet())
        assertEquals(expected.size, app.connectors.chatConnectorReads.size)
        inSheet(hasContentDescription("Back")).performClick()
        waitTag(calendarTag)
        compose.onNodeWithTag(calendarTag).assertIsFocused().performClick()
        waitTag(primaryTag)
        assertEquals(expected.size, app.connectors.chatConnectorReads.size)
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

        app.connectors.rejectChatOverride = 403
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
        val readback = CountDownLatch(1)
        application.connectors.loseChatOverrideReply = true
        application.connectors.chatOverrideReadReplyGate = readback
        application.chats.disconnectSend = true
        application.chats.inputDisposition = "queued"
        try {
            compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
            compose.waitUntil(10_000) {
                compose.runOnIdle { application.connectors.chatOverrideReads.isNotEmpty() }
            }
            assertTrue(application.chats.inputs.isEmpty())
        } finally {
            readback.countDown()
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
        assertEquals(listOf(thread to CONNECTOR_CALENDAR), app.connectors.chatOverrideReads)
    }

    private fun composer() =
        checkNotNull(
                ViewModelProvider(compose.activity)[SessionModel::class.java].uiState.value.ready,
            )
            .composer

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
