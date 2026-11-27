package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.RecoveryApiFixture
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.historyEventWire
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun failureWithoutReply() =
        capture(
            RecoveryApiFixture.failure("provider_image_too_large", seq = 2),
            R.string.run_failure_provider_image_too_large_title,
            "failure-before-reply.png",
        )

    @Test
    fun stoppedWithoutReply() =
        capture(
            historyEventWire(id = "83d804c6-33a8-49b2-b326-f3f340d5120e", seq = 2, type = "run.cancelled", payload = "null"),
            R.string.history_cancelled,
            "stopped-before-reply.png",
        )

    private fun capture(terminal: String, label: Int, filename: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val preferences = app.snapshotApiPreferences()
        fun displayOverride(setting: String): String =
            Regex("Override \\w+: (\\S+)").find(device.executeShellCommand("wm $setting"))
                ?.groupValues?.get(1) ?: "reset"
        val size = displayOverride("size")
        val density = displayOverride("density")
        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun await(value: String) =
            checkNotNull(device.wait(Until.findObject(text(value)), 12_000)) { "Missing $value" }
        ChatListApiFixture().use { fixture ->
            fixture.setHistoryEvents(
                CHAT_PERSONAL,
                listOf(
                    historyEventWire(
                        id = "915697dd-1b9b-4f5b-87a3-4840f224624b",
                        seq = 1,
                        type = "input.prompt",
                        payload = """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Review the launch image."}]}}""",
                    ),
                    terminal,
                ),
            )
            try {
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                app.chatService = fixture.service
                auth.state.value = testAuthenticationState()
                ActivityScenario.launch(MainActivity::class.java).use {
                    await("Personal chat").click()
                    val status = await(app.getString(label))
                    val okou = app.getString(R.string.app_name)
                    val header = await(okou)
                    check(device.findObjects(text(okou)).size == 1)
                    check(header.visibleBounds.bottom < status.visibleBounds.top)
                    if (label == R.string.run_failure_provider_image_too_large_title) {
                        await(app.getString(R.string.run_failure_provider_image_too_large_description))
                    }
                    ScreenshotCapture.capture(filename)
                }
            } finally {
                device.executeShellCommand("wm size $size")
                device.executeShellCommand("wm density $density")
                auth.state.value = previousAuth
                app.chatService = previousChats
                app.restoreApiPreferences(preferences)
                cache.restore()
            }
        }
    }
}
