package ai.okou.android

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.text.TextRange
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w400dp-h800dp",
    application = ComposerRootApplication::class,
)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
internal class ComposerWorkflowRootTest : ChatComposerRootTestFixture() {
    @Test
    fun catalogFailureLeavesTheDraftAndNormalSendAvailable() {
        val app = compose.activity.application as ComposerRootApplication
        val workflows = ComposerWorkflowApiFixture(app.fixture)
        workflows.catalogStatus = 403
        app.contextGate.countDown()
        app.sendGate.countDown()
        compose.onNodeWithText("New chat").performClick()
        val input = compose.onNodeWithTag("message_input")
        input.performTextInput("/missing")
        compose.waitUntilExactlyOneExists(hasText("Workflows are temporarily unavailable"), 8_000)
        input.assertTextContains("/missing").performTextReplacement("Ordinary message")
        compose.onNodeWithTag("composer-workflow-popup").assertDoesNotExist()
        compose.onNodeWithContentDescription("Send").performClick()
        awaitConversation { app.fixture.inputs.size == 1 }
        assertEquals(
            "Ordinary message",
            app.fixture.inputs.values.single()["prompt"]?.jsonPrimitive?.content,
        )
        assertTrue(workflows.recentWrites.isEmpty())
    }

    @Test
    fun completionEditsTheDraftAndOnlyAcceptedSendChangesRecency() {
        val app = compose.activity.application as ComposerRootApplication
        val workflows = ComposerWorkflowApiFixture(app.fixture)
        val catalog = CountDownLatch(1)
        workflows.beforeCatalog = { catalog.await() }
        try {
            app.contextGate.countDown()
            compose.onNodeWithText("New chat").performClick()
            val input = compose.onNodeWithTag("message_input")
            input.performClick().performTextInput("Please run /release-c")
            compose.waitUntilExactlyOneExists(hasText("Loading workflows"), 8_000)
            catalog.countDown()
            compose.waitUntilExactlyOneExists(hasText("/release-check"), 8_000)
            assertEquals(1, workflows.catalogReads.size)
            compose.onNodeWithText("/release-check").performClick()
            input.assertIsFocused().assertTextContains("Please run /release-check ")
            compose.onNodeWithTag("composer-workflow-popup").assertDoesNotExist()
            assertTrue(app.fixture.inputs.isEmpty())
            assertTrue(workflows.recentWrites.isEmpty())
            compose.onNodeWithContentDescription("Send").performClick()
            awaitConversation { app.fixture.inputs.size == 1 }
            assertEquals(
                "Please run /release-check ",
                app.fixture.inputs.values.single()["prompt"]?.jsonPrimitive?.content,
            )
            assertTrue(workflows.recentWrites.isEmpty())
            app.sendGate.countDown()
            awaitConversation { workflows.recentWrites.isNotEmpty() }
            assertEquals(
                listOf(listOf(ComposerWorkflowApiFixture.ReleaseId)),
                workflows.recentWrites,
            )
        } finally {
            catalog.countDown()
        }
    }

    @Test
    fun choosingACommandBeforeANewlineClosesSuggestionsUntilTheCaretReturns() {
        val app = compose.activity.application as ComposerRootApplication
        ComposerWorkflowApiFixture(app.fixture)
        app.contextGate.countDown()
        compose.onNodeWithText("New chat").performClick()
        val input = compose.onNodeWithTag("message_input")
        input.performTextInput("/rel\nKeep this line")
        input.performTextInputSelection(TextRange(4))
        compose.waitUntilExactlyOneExists(hasText("/release-check"), 8_000)
        compose.onNodeWithText("/release-check").performClick()
        input.assertIsFocused().assertTextContains("/release-check\nKeep this line")
        compose.onNodeWithTag("composer-workflow-popup").assertDoesNotExist()

        val commandEnd = "/release-check".length
        input.performTextInputSelection(TextRange(commandEnd + 1))
        compose.onNodeWithTag("composer-workflow-popup").assertDoesNotExist()
        input.performTextInputSelection(TextRange(commandEnd))
        compose.onNodeWithText("/release-check").assertIsDisplayed()

        input.performTextInput("s")
        input.assertTextContains("/release-checks\nKeep this line")
        compose.onNodeWithText("No matching workflows").assertIsDisplayed()
    }

    @Test
    fun keyboardCompletionAndExplicitPickerShareTheCatalogInAnExistingChat() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val recent = CountDownLatch(1)
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            val app = compose.activity.application as ComposerRootApplication
            val workflows = ComposerWorkflowApiFixture(app.fixture)
            workflows.beforeRecent = { recent.await() }
            app.contextGate.countDown()
            app.sendGate.countDown()
            compose.waitUntilExactlyOneExists(hasText("Personal chat"), 8_000)
            compose.onNodeWithText("Personal chat").performClick()
            val input = compose.onNodeWithTag("message_input")
            input.performClick().performTextInput("/")
            compose.waitUntilExactlyOneExists(hasText("/daily-digest"), 8_000)
            recent.countDown()
            compose.waitUntilExactlyOneExists(hasText("Recently used"), 8_000)
            compose.onNodeWithText("Recently used").assertIsDisplayed()
            input.performKeyInput {
                pressKey(Key.DirectionDown)
                pressKey(Key.Enter)
            }
            input.assertTextContains("/review-changes ").assertIsFocused()
            input.performTextInput("Keep this text")
            val selectedStart = "/review-changes Keep ".length
            input.performTextInputSelection(TextRange(selectedStart + "this".length, selectedStart))
            compose.onNodeWithTag("chat-options-button").performClick()
            compose.onNodeWithTag("chat-options-workflows").performClick()
            compose
                .onNodeWithTag("composer-workflow-search")
                .performClick()
                .performTextInput("daily")
            compose.waitUntilExactlyOneExists(hasText("/daily-digest"), 8_000)
            compose.onNodeWithText("/daily-digest").assertIsDisplayed().performClick()
            input
                .assertTextContains("/review-changes Keep this /daily-digest text")
                .assertIsFocused()
            assertTrue(app.fixture.inputs.isEmpty())
        } finally {
            recent.countDown()
            instrumentation.resetInTouchMode()
        }
    }
}
