package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
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
    fun captureRelatedChatsBelowArtifactsInBothLayouts() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val oldPreferences = app.initialPreferences
        val oldApiPreferences = app.snapshotApiPreferences()
        val oldConnectivity = app.connectivity.value
        val oldSize = device.executeShellCommand("wm size")
        val oldDensity = device.executeShellCommand("wm density")
        val oldFontScale = device.executeShellCommand("settings get system font_scale").trim()
        val database = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { api ->
            val artifacts = ArtifactApiFixture(api, chinese = true)
            artifacts.install()
            val events = api.events
            api.events = { request ->
                if (request.requestUrl?.queryParameter("sinceSeqId") == null) {
                    val source = chatEventWire(title = artifacts.sourceTitle)
                    val peer = chatEventWire(
                        id = "77777777-7777-4777-8777-777777777777",
                        seq = 23,
                        thread = CHAT_IN_PROJECT,
                        title = "确认发布安排",
                        extra = ",\"projectId\":\"44444444-4444-4444-8444-444444444444\"",
                    )
                    jsonResponse("""{"events":[$source,$peer],"hasMore":false}""")
                } else events(request)
            }
            val respond = api.commandResponse
            api.commandResponse = { request ->
                if (request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL/relations/communications") {
                    jsonResponse("""{"items":[{"threadId":"$CHAT_IN_PROJECT","title":"确认发布安排","status":"idle","sentCount":1,"receivedCount":0,"lastMessageAt":"2026-11-22T09:00:00Z"}]}""")
                } else respond(request)
            }
            try {
                auth.state.value = testAuthenticationState(user = "related-resources-${UUID.randomUUID()}")
                app.chatService = api.service
                app.initialPreferences = testPreferences().copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = UserPreferencesTheme.LIGHT,
                    timezone = "Asia/Shanghai",
                )
                app.connectivity.value = true
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                capture(412, 892, "related-chats-phone.png", artifacts)
                capture(1180, 820, "related-chats-wide.png", artifacts)
            } finally {
                restoreDisplay("size", oldSize)
                restoreDisplay("density", oldDensity)
                if (oldFontScale.toFloatOrNull() == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else device.executeShellCommand("settings put system font_scale $oldFontScale")
                auth.state.value = oldAuth
                app.chatService = oldService
                app.initialPreferences = oldPreferences
                app.restoreApiPreferences(oldApiPreferences)
                app.connectivity.value = oldConnectivity
                database.restore()
            }
        }
    }

    private fun capture(width: Int, height: Int, filename: String, artifacts: ArtifactApiFixture) {
        device.executeShellCommand("wm size ${width}x$height")
        ActivityScenario.launch(MainActivity::class.java).use { activity ->
            activity.onActivity {
                assertEquals(width, it.resources.configuration.screenWidthDp)
                assertEquals(160, it.resources.configuration.densityDpi)
            }
            node(By.text(artifacts.sourceTitle)).click()
            node(By.desc("聊天操作").enabled(true)).click()
            node(By.text("对话资料")).click()
            val result = node(By.textContains(artifacts.summary.title)).visibleBounds
            val heading = node(By.text("关联聊天")).visibleBounds
            val peer = node(By.text("确认发布安排")).visibleBounds
            assertTrue(result.bottom < heading.top)
            assertTrue(heading.bottom < peer.top)
            if (width > 600) assertTrue(node(By.desc("成果")).visibleBounds.right < peer.left)
            ScreenshotCapture.capture(filename)
        }
    }

    private fun node(selector: BySelector) =
        checkNotNull(device.wait(Until.findObject(By.copy(selector).pkg(app.packageName)), 15_000)) {
            val labels = device.findObjects(By.pkg(app.packageName)).mapNotNull { it.text }
            "Missing $selector among $labels"
        }

    private fun restoreDisplay(setting: String, previous: String) {
        val overrideValue = previous.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
        device.executeShellCommand("wm $setting ${overrideValue ?: "reset"}")
    }
}
