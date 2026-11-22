package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun capturesConversationArtifactsAndSharedPreview() {
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousService = app.chatService
        val previousPreferences = app.snapshotApiPreferences()
        val chatCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val user = "chat-artifacts-${UUID.randomUUID()}"
        val size = device.executeShellCommand("wm size").trim()
        val density = device.executeShellCommand("wm density").trim()
        ChatListApiFixture().use { api ->
            val data =
                ArtifactApiFixture(api, chinese = true).apply {
                    pageSize = 2
                    install()
                }
            app.chatService = api.service
            app.restoreApiPreferences(
                previousPreferences +
                    (Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                        testPreferences()
                            .copy(
                                locale = UserPreferencesLocale.ZH_HANS,
                                theme = UserPreferencesTheme.LIGHT,
                            ))
            )
            auth.state.value = testAuthenticationState(user = user)
            try {
                device.executeShellCommand("wm size 1080x2340")
                ActivityScenario.launch(MainActivity::class.java).use {
                    node(By.text(data.sourceTitle)).click()
                    node(By.desc("聊天操作").enabled(true)).click()
                    node(By.text("对话资料")).click()
                    node(By.text(data.slides.title))
                    assertTrue(data.catalogScopes.contains(CHAT_PERSONAL to "2"))
                    assertTrue(data.catalogScopes.all { it.first == CHAT_PERSONAL })
                    ScreenshotCapture.capture("chat-resources.png")

                    node(By.text(data.summary.title)).click()
                    node(By.textContains("定位：帮助团队"))
                    node(By.textContains("仅供预览"))
                    ScreenshotCapture.capture("chat-artifact-preview.png")
                    assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                    node(By.text(data.summary.title))

                    device.executeShellCommand("wm size 1180x820")
                    device.executeShellCommand("wm density 160")
                    val chat = node(By.text(data.sourceTitle))
                    val first = node(By.text(data.checklist.title))
                    val resource = node(By.text(data.summary.title))
                    assertTrue(chat.visibleBounds.right < resource.visibleBounds.left)
                    assertEquals(72, resource.visibleBounds.top - first.visibleBounds.top)
                    ScreenshotCapture.capture("chat-resources-wide.png")
                    assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                    node(By.desc("聊天操作").enabled(true))
                }
            } finally {
                restoreSetting("size", size)
                restoreSetting("density", density)
                auth.state.value = previousAuth
                app.chatService = previousService
                app.restoreApiPreferences(previousPreferences)
                chatCache.restore()
            }
        }
    }

    private fun node(selector: BySelector) =
        checkNotNull(
            device.wait(Until.findObject(By.copy(selector).pkg(app.packageName)), 12_000)
        ) {
            "Missing chat resources state: $selector"
        }

    private fun restoreSetting(setting: String, receipt: String) {
        val override =
            receipt.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
        device.executeShellCommand("wm $setting ${override ?: "reset"}")
    }
}
