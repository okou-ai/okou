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
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun projectFromCollapsedToExpanded() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val authentication = app.authentication as TestAuthentication
        val previousAuth = authentication.state.value
        val previousService = app.chatService
        val savedPreferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        app.chatService = fixture.service
        authentication.state.value = testAuthenticationState(user = "project-expansion-screenshot")
        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                device.awaitChatList(app)
                val research = By.pkg(app.packageName).text("Research")
                val child = By.pkg(app.packageName).text("Project chat")
                val project = checkNotNull(device.wait(Until.findObject(research), 10_000))
                check(!device.hasObject(child))
                ScreenshotCapture.capture("projects-collapsed.png")
                project.click()
                check(device.wait(Until.hasObject(child), 10_000))
                ScreenshotCapture.capture("projects-expanded.png")
                checkNotNull(device.findObject(research)).click()
                check(device.wait(Until.gone(child), 10_000))
            }
        } finally {
            fixture.close()
            cache.restore()
            app.restoreApiPreferences(savedPreferences)
            app.chatService = previousService
            authentication.state.value = previousAuth
        }
    }
}
