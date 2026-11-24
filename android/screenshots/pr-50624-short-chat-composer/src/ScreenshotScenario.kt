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
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
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
