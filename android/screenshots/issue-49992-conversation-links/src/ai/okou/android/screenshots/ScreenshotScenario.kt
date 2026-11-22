package ai.okou.android.screenshots

import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.HISTORY_LAST_EVENT
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun captureConversationLinks() {
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousService = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val size = displayOverride("size")
        val density = displayOverride("density")
        val fixture = ChatListApiFixture()
        fixture.historyRows = { request ->
            val url = checkNotNull(request.requestUrl)
            val thread = url.pathSegments[2]
            val after = url.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0
            val markdown =
                if (thread == CHAT_PERSONAL) {
                    "The launch notes are ready. Open the linked update to review the final checklist.\n\n" +
                        "Read the [Android documentation](https://developer.android.com/) for platform context.\n\n" +
                        "[Project release update](/chats/$CHAT_IN_PROJECT#event-output)\n\n" +
                        "[Unavailable conversation](/chats/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)"
                } else "Release checklist approved. The launch may proceed."
            val rows = buildList {
                if (after < 17)
                    add(
                        historyEventWire(
                            "input",
                            17,
                            thread,
                            "input.prompt",
                            """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Review the project release"}]}}""",
                        )
                    )
                if (after < 23)
                    add(
                        historyEventWire(
                            "output",
                            23,
                            thread,
                            payload = """{"content":${JsonPrimitive(markdown)}}""",
                        )
                    )
                if (after < 37)
                    add(historyEventWire(HISTORY_LAST_EVENT, 37, thread, "run.completed", "null"))
            }
            jsonResponse(
                """{"rows":[${rows.joinToString(",")}],"cursor":{"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":37},"hasMore":false}"""
            )
        }
        app.chatService = fixture.service
        auth.state.value = testAuthenticationState(user = "conversation-links-${UUID.randomUUID()}")
        try {
            device.executeShellCommand("wm size 1080x1920")
            device.executeShellCommand("wm density 420")
            ActivityScenario.launch(MainActivity::class.java).use {
                device.awaitChatList(app)
                text("Personal chat").click()
                val link = text("Project release update", partial = true)
                text("Android documentation", partial = true)
                ScreenshotCapture.capture("01-phone-inline-links.png")

                link.click()
                text("Release checklist approved. The launch may proceed.")
                ScreenshotCapture.capture("02-phone-message-target.png")
                check(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                text("Project release update", partial = true)
                ScreenshotCapture.capture("03-phone-source-return.png")

                device.executeShellCommand("wm size 1120x860")
                device.executeShellCommand("wm density 160")
                device.awaitChatList(app)
                text("Project release update", partial = true)
                ScreenshotCapture.capture("04-wide-inline-links.png")
                text("Unavailable conversation", partial = true).click()
                text(app.getString(R.string.conversation_link_unavailable))
                ScreenshotCapture.capture("05-unavailable-link.png")
            }
        } finally {
            device.executeShellCommand("wm size ${size ?: "reset"}")
            device.executeShellCommand("wm density ${density ?: "reset"}")
            fixture.close()
            cache.restore()
            app.restoreApiPreferences(preferences)
            app.chatService = previousService
            auth.state.value = previousAuth
        }
    }

    private fun displayOverride(property: String): String? =
        Regex("Override ${property}: (.+)")
            .find(device.executeShellCommand("wm $property"))
            ?.groupValues
            ?.get(1)

    private fun text(value: String, partial: Boolean = false) =
        await(
            By.pkg(app.packageName).let { if (partial) it.textContains(value) else it.text(value) }
        )

    private fun await(selector: BySelector) =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $selector" }
}
