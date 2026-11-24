package ai.okou.android.screenshots

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
import android.graphics.Rect
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
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
    fun editsTheSameDraftInRegularAndShortWindows() {
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
            val draft = "Review the notes\nConfirm the rollout\nShare the update"
            api.setThreadDraft(CHAT_PERSONAL, draft)
            app.chatService = api.service
            app.composerService = api.service
            app.controlService = api.service
            auth.state.value = testAuthenticationState(user = "short-composer-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 2.0")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    device.awaitChatList(app)
                    checkNotNull(
                        device.wait(Until.findObject(By.pkg(app.packageName).text("Personal chat")), 12_000),
                    ).click()
                    waitForWindow(scenario, short = false)
                    val editor = By.pkg(app.packageName).clazz("android.widget.EditText")
                    val send = By.pkg(app.packageName).desc(app.getString(R.string.composer_send))
                    val authoredDraft = object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) = device.findObject(editor)?.text == draft
                    }
                    check(device.wait(authoredDraft, 12_000)) { "The multiline draft did not appear" }
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) = device.findObject(send)?.isEnabled == true
                    }, 12_000))
                    val regularHeight = checkNotNull(device.findObject(editor)).visibleBounds.height()
                    ScreenshotCapture.capture("01-regular-draft.png")

                    device.executeShellCommand("wm size 540x320")
                    waitForWindow(scenario, short = true)
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            val compactHeight = device.findObject(editor)?.visibleBounds?.height() ?: return false
                            val sendBounds = device.findObject(send)?.visibleBounds ?: return false
                            return device.findObject(editor)?.text == draft.replace('\n', ' ') &&
                                compactHeight in 48 until regularHeight &&
                                sendBounds.width() == 48 && sendBounds.height() == 48
                        }
                    }, 12_000)) { "Compact height or 48dp Send target did not match the design" }
                    ScreenshotCapture.capture("02-short-draft.png")

                    device.executeShellCommand("wm size 412x892")
                    waitForWindow(scenario, short = false)
                    check(device.wait(authoredDraft, 12_000)) { "Returning to the regular window lost the original line breaks" }
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

    @Test
    fun capturesConversationTextActionsAtRestAndUnderTouch() {
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
            val suggestion = "Group the checklist by owner"
            val followups =
                """{"version":1,"followups":[{"prompt":"$suggestion","kind":"talk"},{"prompt":"Write a one-page launch brief","kind":"generate","generationType":"presentation"},{"prompt":"Create a workflow to recheck the launch checklist and remind each owner","kind":"workflow"}]}"""
            fun id(seq: Long) = "50624000-0000-4000-8000-${seq.toString().padStart(12, '0')}"
            fun row(seq: Long, type: String, payload: String) = historyEventWire(
                id(seq), seq, type = type, payload = payload,
            )
            fun content(text: String) = """{"content":${JsonPrimitive(text)}}"""
            val rows = listOf(
                row(1, "input.prompt", """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Review the release materials"}]}}"""),
                row(2, "output.message", content("I checked the website links.")),
                row(3, "output.message", content("I confirmed the brief email copy.")),
                row(4, "output.message", content("**The release materials are ready.**\n\nThe website and email are confirmed. Two checks remain before launch.")),
                row(5, "run.completed", "null"),
                row(6, "output.followups", content(followups)),
            )
            api.historyCatchUp = { MockResponse().setResponseCode(503) }
            api.historyRows = { request ->
                val since = request.requestUrl?.queryParameter("sinceSeqId")?.toInt() ?: 0
                jsonResponse(
                    """{"rows":[${rows.drop(since).joinToString(",")}],"cursor":{"lastEventId":"${id(6)}","lastSeqId":6},"hasMore":false}""",
                )
            }
            app.chatService = api.service
            app.composerService = api.service
            app.controlService = api.service
            auth.state.value = testAuthenticationState(user = "chat-rows-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    checkNotNull(device.wait(Until.findObject(By.pkg(app.packageName).text("Personal chat")), 12_000)).click()
                    val summarySelector = By.pkg(app.packageName).textContains("2 steps")
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) = api.readRequests.get() > 0
                    }, 12_000)) { "Fixture history never reached its initial reading position" }
                    val summary = action(summarySelector)
                    val followup = action(By.pkg(app.packageName).text(suggestion))
                    check(summary.height() >= 48 && followup.height() == 48)
                    check(summary.left == 16 && followup.left == 16 && followup.right == 388)
                    check(summary.right < followup.right)
                    ScreenshotCapture.capture("03-text-actions-idle.png")
                    capturePress(summary, "04-summary-pressed.png")
                    capturePress(followup, "05-suggestion-pressed.png")
                    check(device.click(summary.centerX(), summary.centerY()))
                    val earlier = By.pkg(app.packageName).text("I checked the website links.")
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            val first = device.findObject(earlier)?.visibleBounds ?: return false
                            val expanded = action(summarySelector)
                            return expanded.top == summary.top && first.top >= expanded.bottom
                        }
                    }, 12_000)) { "Earlier replies did not stay below the summary" }
                    ScreenshotCapture.capture("06-summary-expanded.png")
                    checkNotNull(device.wait(Until.findObject(By.pkg(app.packageName).desc(app.getString(R.string.chat_actions))), 12_000)).click()
                    check(device.wait(Until.hasObject(By.pkg(app.packageName).text(app.getString(R.string.conversation_find))), 12_000))
                    check(!device.hasObject(By.pkg(app.packageName).text(app.getString(R.string.settings))))
                    ScreenshotCapture.capture("07-chat-overflow.png")
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

    private fun action(selector: BySelector): Rect {
        val node = checkNotNull(device.wait(Until.findObject(selector), 12_000))
        val clickable = node.takeIf { it.isClickable } ?: checkNotNull(node.parent)
        check(clickable.isClickable)
        return clickable.visibleBounds
    }

    private fun capturePress(bounds: Rect, filename: String) {
        val x = bounds.left + 4
        val y = bounds.centerY()
        fun pixel(): Int {
            val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            return try { image.getPixel(x, y) } finally { image.recycle() }
        }
        val rest = pixel()
        val downTime = SystemClock.uptimeMillis()
        fun inject(action: Int) {
            val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x.toFloat(), y.toFloat(), 0)
            try {
                event.source = InputDevice.SOURCE_TOUCHSCREEN
                check(instrumentation.uiAutomation.injectInputEvent(event, true))
            } finally {
                event.recycle()
            }
        }
        inject(MotionEvent.ACTION_DOWN)
        try {
            check(device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice) = pixel() != rest
            }, 3_000)) { "The touch gutter did not show a pressed background for $filename" }
            ScreenshotCapture.capture(filename)
        } finally {
            inject(MotionEvent.ACTION_CANCEL)
        }
        check(device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice) = pixel() == rest
        }, 3_000)) { "The pressed background remained after touch cancellation" }
    }

    private fun waitForWindow(scenario: ActivityScenario<MainActivity>, short: Boolean) {
        check(device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean {
                var ready = false
                scenario.onActivity {
                    val config = it.resources.configuration
                    ready = (config.screenHeightDp < 480) == short && config.fontScale == 2f
                }
                return ready
            }
        }, 12_000)) { "Window did not reach the expected size and font scale" }
    }

    private fun displayOverride(kind: String): String =
        device.executeShellCommand("wm $kind").lineSequence().firstOrNull { it.startsWith("Override") }
            ?.substringAfter(':')?.trim() ?: "reset"
}
