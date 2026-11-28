package ai.okou.android.screenshots

import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun wrappedConversationLink() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val preferences = app.snapshotApiPreferences()
        fun displayOverride(setting: String): String =
            Regex("Override \\w+: (\\S+)")
                .find(device.executeShellCommand("wm $setting"))
                ?.groupValues
                ?.get(1) ?: "reset"
        val size = displayOverride("size")
        val density = displayOverride("density")
        ChatListApiFixture().use { fixture ->
            fixture.historyReply =
                "更换模型后重试。账号、积分和新建聊天入口的待对齐项已反馈到「设计稿」。\n\n" +
                    "并记录进 v444 的 Android 验收章节。 [设计稿对话](/chats/$CHAT_IN_PROJECT)" +
                    " · Android 恢复入口验收"
            try {
                device.executeShellCommand("wm size 360x780")
                device.executeShellCommand("wm density 160")
                app.chatService = fixture.service
                auth.state.value = testAuthenticationState()
                ActivityScenario.launch(MainActivity::class.java).use {
                    val configured =
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice) =
                                device.displayWidth == 360 &&
                                    app.resources.displayMetrics.densityDpi == 160
                        }
                    check(device.wait(configured, 8_000) == true)
                    val chat = By.pkg(app.packageName).text("Personal chat")
                    checkNotNull(device.wait(Until.findObject(chat), 12_000)).click()
                    val reply = By.pkg(app.packageName).textContains("Android 恢复入口验收")
                    checkNotNull(device.wait(Until.findObject(reply), 12_000))
                    ScreenshotCapture.capture("wrapped-conversation-link.png")
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
