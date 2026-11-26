package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.HISTORY_LAST_EVENT
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.historyEventWire
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun findsASentAttachmentAndOpensTheOriginalMessage() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldChats = app.chatService
        val oldComposer = app.composerService
        val prefs = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val filename = "Launch checklist.txt"
        val response = "I will use the checklist to prepare the release."
        val packageName = app.packageName
        fun text(label: String) = By.pkg(packageName).text(label)
        fun find(selector: BySelector, label: String) =
            checkNotNull(device.wait(Until.findObject(selector), 15_000)) { label }
        fun description(resource: Int) = By.pkg(packageName).desc(app.getString(resource))

        ComposerApiFixture(simulateHistory = false).use { fixture ->
            fixture.chats.setHistoryEvents(
                CHAT_PERSONAL,
                listOf(
                    historyEventWire(
                        id = "f97590a3-47ba-4bd4-8556-79d6097b0fa1",
                        seq = 17,
                        type = "input.prompt",
                        payload = """{"userMessage":{"version":1,"parts":[{"type":"file","fileId":"aa206063-25b8-4b2d-bc1b-f92fc083c149","filenameSnapshot":"$filename","contentType":"text/plain"}]}}""",
                    ),
                    historyEventWire(
                        id = "d22f24ac-c505-402c-aafd-b09423930ed4",
                        seq = 23,
                        payload = """{"content":"$response"}""",
                    ),
                    historyEventWire(id = HISTORY_LAST_EVENT, type = "run.completed", payload = "null"),
                ),
            )
            try {
                app.chatService = fixture.service
                app.composerService = fixture.service
                auth.state.value = testAuthenticationState(user = "find-capture")
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    find(text("Personal chat"), "Personal chat").click()
                    find(text(response), "Fixture transcript")
                    find(description(R.string.chat_actions), "Conversation actions").click()
                    find(text(app.getString(R.string.conversation_find)), "Find messages menu item").click()
                    find(text(app.getString(R.string.conversation_find_turns)), "Browse turns")
                    find(text(app.getString(R.string.conversation_find_loaded_scope)), "Search scope")
                    find(text(app.getString(R.string.conversation_find_attachment)), "Attachment-only turn")
                    ScreenshotCapture.capture("find-browse-attachments.png")

                    val input = By.pkg(packageName).clazz("android.widget.EditText").focused(true)
                    find(input, "Focused Find query").text = "CHECKLIST.TXT"
                    val count = app.resources.getQuantityString(R.plurals.conversation_find_matches, 1, 1)
                    find(text(count), "Exactly one filename match")
                    find(text(app.getString(R.string.conversation_find_loaded_scope)), "Search scope")
                    val filenameText = By.pkg(packageName).textContains(filename)
                    val result = find(filenameText, "Filename excerpt")
                    ScreenshotCapture.capture("find-filename-match.png")
                    result.click()

                    check(device.wait(Until.gone(text(count)), 15_000)) { "Search results remained open" }
                    find(filenameText, "Original attachment card")
                    find(description(R.string.chat_actions), "Original chat toolbar")
                    ScreenshotCapture.capture("find-original-message.png")
                }
            } finally {
                app.chatService = oldChats
                app.composerService = oldComposer
                auth.state.value = oldAuth
                app.restoreApiPreferences(prefs)
                cache.restore()
            }
        }
    }
}
