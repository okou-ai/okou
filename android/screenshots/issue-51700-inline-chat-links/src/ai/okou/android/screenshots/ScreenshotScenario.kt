package ai.okou.android.screenshots

import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.testAuthenticationState
import android.app.UiModeManager
import android.content.res.Configuration
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @get:Rule val compose = createEmptyComposeRule()

    @Test
    fun screenshotLightLinks() =
        capture("light", UiModeManager.MODE_NIGHT_NO, Configuration.UI_MODE_NIGHT_NO)

    @Test
    fun screenshotDarkLinks() =
        capture("dark", UiModeManager.MODE_NIGHT_YES, Configuration.UI_MODE_NIGHT_YES)

    private fun capture(theme: String, mode: Int, expectedNightMode: Int) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val automation = instrumentation.uiAutomation
        val nightMode = requireNotNull(app.getSystemService(UiModeManager::class.java))
        val oldMode = nightMode.nightMode
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldChatService = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val label = "the complete launch checklist and follow-up decisions for everyone on the team"
        fixture.historyReply =
            "Read [Project chat](/chats/$CHAT_IN_PROJECT) for context.\n\n" +
                "Open [$label](/chats/$CHAT_IN_PROJECT#event-output) before the handoff."
        val failures = mutableListOf<Throwable>()
        var activity: ActivityScenario<MainActivity>? = null
        fun attempt(action: () -> Unit) {
            try {
                action()
            } catch (failure: Throwable) {
                failures += failure
            }
        }
        try {
            automation.adoptShellPermissionIdentity("android.permission.MODIFY_DAY_NIGHT_MODE")
            nightMode.nightMode = mode
            app.chatService = fixture.service
            auth.state.value = testAuthenticationState(user = "link-capture-${UUID.randomUUID()}")
            val scenario = ActivityScenario.launch(MainActivity::class.java)
            activity = scenario
            scenario.onActivity {
                assertEquals(
                    expectedNightMode,
                    it.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK,
                )
            }
            val sourceChat = hasTestTag("chat_$CHAT_PERSONAL")
            compose.waitUntilExactlyOneExists(sourceChat, 10_000)
            compose.onNode(sourceChat).performClick()

            val markers = SemanticsMatcher.keyIsDefined(SemanticsProperties.LinkTestMarker)
            val anchored = markers and hasAnyAncestor(hasText(label, substring = true))
            compose.waitUntil(10_000) {
                compose.onAllNodes(anchored, useUnmergedTree = true).fetchSemanticsNodes().size == 1
            }
            val link = compose.onNode(anchored, useUnmergedTree = true).assertIsDisplayed()
            val body = compose.onNodeWithText(label, substring = true).assertIsDisplayed()
            val layouts = mutableListOf<TextLayoutResult>()
            body.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            val layout = layouts.single()
            val text = layout.layoutInput.text
            val range = text.getLinkAnnotations(0, text.length).single()
            assertTrue(
                layout.getLineForOffset(range.start) < layout.getLineForOffset(range.end - 1),
            )
            assertEquals(1, layout.placeholderRects.size)
            compose.waitForIdle()
            ScreenshotCapture.capture("links-$theme.png")

            instrumentation.setInTouchMode(false)
            link.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
            compose.waitForIdle()
            ScreenshotCapture.capture("links-focus-$theme.png")

            link.performKeyInput { pressKey(Key.Enter) }
            val hit = hasTestTag("conversation_find_hit")
            compose.waitUntilExactlyOneExists(hit, 10_000)
            compose.onNode(hit).assertIsDisplayed()
            compose.onNodeWithContentDescription("Back").performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodes(anchored, useUnmergedTree = true).fetchSemanticsNodes().size == 1
            }
            link.assertIsFocused()
            val plain = markers and hasAnyAncestor(hasText("Read", substring = true))
            compose.onNode(plain, useUnmergedTree = true).performTouchInput { click() }
            compose.waitUntilExactlyOneExists(hasText("Project chat", ignoreCase = false), 10_000)
            compose.onNodeWithText("Project chat").assertIsDisplayed()
        } catch (failure: Throwable) {
            failures += failure
            attempt { ScreenshotCapture.capture("links-failure-$theme.png") }
        } finally {
            attempt { activity?.close() }
            attempt { fixture.close() }
            attempt { cache.restore() }
            attempt { app.restoreApiPreferences(preferences) }
            attempt { app.chatService = oldChatService }
            attempt { auth.state.value = oldAuth }
            attempt { instrumentation.resetInTouchMode() }
            attempt { nightMode.nightMode = oldMode }
            attempt { automation.dropShellPermissionIdentity() }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
