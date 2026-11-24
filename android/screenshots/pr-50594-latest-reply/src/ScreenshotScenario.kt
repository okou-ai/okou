package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun showsAndOpensTheUnreadReplyAboveSuggestions() {
        val originalSize = displayOverride("size")
        val originalDensity = displayOverride("density")
        val originalFont = device.executeShellCommand("settings get system font_scale").trim()
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChat = app.chatService
        val originalComposer = app.composerService
        val originalControls = app.controlService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { api ->
            val reply = "The release is ready."
            val suggestions =
                """{"version":1,"followups":[{"kind":"talk","prompt":"Summarize the release notes"},{"kind":"email","prompt":"Draft the announcement"},{"kind":"workflow","prompt":"Set up a release checklist"}]}"""
            fun id(sequence: Long) = "50585000-0000-4000-8000-${sequence.toString().padStart(12, '0')}"
            fun row(sequence: Long, type: String, payload: String) =
                historyEventWire(id(sequence), sequence, type = type, payload = payload)
            val rows = listOf(
                row(1, "output.message", """{"content":${JsonPrimitive(reply)}}"""),
                row(2, "run.completed", "null"),
                row(3, "output.followups", """{"content":${JsonPrimitive(suggestions)}}"""),
            )
            api.indicators = {
                jsonResponse(
                    """{"threads":{"$CHAT_PERSONAL":"unread"},"unreadAt":{"$CHAT_PERSONAL":"$CHAT_DATE"}}""",
                )
            }
            api.historyCatchUp = { MockResponse().setResponseCode(503) }
            api.historyRows = { request ->
                val after = request.requestUrl?.queryParameter("sinceSeqId")?.toInt() ?: 0
                val tail = rows.drop(after).joinToString(",")
                jsonResponse(
                    """{"rows":[$tail],"cursor":{"lastEventId":"${id(3)}","lastSeqId":3},"hasMore":false}""",
                )
            }
            app.chatService = api.service
            app.composerService = api.service
            app.controlService = api.service
            auth.state.value = testAuthenticationState(user = "latest-jump-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("wm size 540x320")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    checkNotNull(device.wait(Until.findObject(By.pkg(app.packageName).text("Personal chat")), 12_000)).click()
                    val replySelector = By.pkg(app.packageName).text(reply)
                    val jump = By.pkg(app.packageName).desc(app.getString(R.string.conversation_new_reply))
                    val button = checkNotNull(device.wait(Until.findObject(jump), 12_000))
                    check(!device.hasObject(replySelector))
                    check(api.readRequests.get() == 0)
                    check(button.visibleBounds.height() >= 48 && button.visibleBounds.centerX() > device.displayWidth / 2)
                    ScreenshotCapture.capture("01-suggestions-hide-unread-reply.png")
                    button.click()
                    check(device.wait(Until.hasObject(replySelector), 12_000))
                    check(device.wait(Until.gone(jump), 12_000))
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) = api.readRequests.get() > 0
                    }, 12_000))
                    ScreenshotCapture.capture("02-jump-reveals-reply.png")
                }
            } finally {
                try {
                    cache.restore()
                } finally {
                    auth.state.value = originalAuth
                    app.chatService = originalChat
                    app.composerService = originalComposer
                    app.controlService = originalControls
                    device.executeShellCommand("wm size $originalSize")
                    device.executeShellCommand("wm density $originalDensity")
                    if (originalFont.toFloatOrNull() == null)
                        device.executeShellCommand("settings delete system font_scale")
                    else device.executeShellCommand("settings put system font_scale $originalFont")
                }
            }
        }
    }

    private fun displayOverride(kind: String): String =
        device.executeShellCommand("wm $kind").lineSequence().firstOrNull { it.startsWith("Override") }
            ?.substringAfter(':')?.trim() ?: "reset"
}
