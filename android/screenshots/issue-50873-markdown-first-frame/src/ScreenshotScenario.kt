package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun opensHistoryWithAFormattedReply() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { fixture ->
            fixture.historyReply =
                "# Launch checklist\n\n**Ready to review**\n\n- Confirm positioning\n- Review the announcement"
            app.chatService = fixture.service
            auth.state.value = testAuthenticationState(user = "markdown-${UUID.randomUUID()}")
            try {
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    checkNotNull(device.wait(Until.findObject(By.text("Personal chat")), 10_000))
                        .click()
                    checkNotNull(device.wait(Until.findObject(By.text("Launch checklist")), 10_000))
                    checkNotNull(device.wait(Until.findObject(By.textContains("Confirm positioning")), 10_000))
                    ScreenshotCapture.capture("markdown-conversation.png")
                }
            } finally {
                auth.state.value = oldAuth
                app.chatService = oldService
                app.restoreApiPreferences(preferences)
                cache.restore()
            }
        }
    }
}
