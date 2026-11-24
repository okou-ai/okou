package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
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
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun captureWorkspaceCatalogAndSharedPreviews() {
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
            val artifacts =
                ArtifactApiFixture(
                    api,
                    chinese = true,
                    imageBody = "unreadable fixture image".encodeToByteArray(),
                    includeVideo = true,
                )
            artifacts.install()
            try {
                auth.state.value = testAuthenticationState(user = "artifact-design-${UUID.randomUUID()}")
                app.chatService = api.service
                app.initialPreferences = testPreferences().copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = UserPreferencesTheme.LIGHT,
                    timezone = "Asia/Shanghai",
                )
                app.connectivity.value = true
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                open(412, 892, artifacts) { capturePhone(artifacts) }
                open(1180, 820, artifacts) { captureWide(artifacts) }
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

    private fun open(width: Int, height: Int, artifacts: ArtifactApiFixture, block: () -> Unit) {
        device.executeShellCommand("wm size ${width}x$height")
        ActivityScenario.launch(MainActivity::class.java).use { activity ->
            activity.onActivity {
                assertEquals(width, it.resources.configuration.screenWidthDp)
                assertEquals(160, it.resources.configuration.densityDpi)
                assertEquals(1f, it.resources.configuration.fontScale, 0f)
            }
            node(By.text(artifacts.sourceTitle))
            node(By.desc("成果").enabled(true)).click()
            val today = node(By.text("今天")).visibleBounds
            val yesterday = node(By.text("昨天")).visibleBounds
            val earlier = node(By.text("更早")).visibleBounds
            assertTrue(today.bottom < yesterday.top)
            assertTrue(yesterday.bottom < earlier.top)
            block()
        }
    }

    private fun capturePhone(artifacts: ArtifactApiFixture) {
        val avatar = control(artifacts.image.title)
        val avatarPosition = avatar.visibleBounds
        ScreenshotCapture.capture("catalog-phone.png")
        avatar.click()
        node(By.text("此文件暂不支持预览"))
        ScreenshotCapture.capture("unavailable-phone.png")
        node(By.desc("返回成果列表")).click()
        assertEquals(avatarPosition, control(artifacts.image.title).visibleBounds)
        control("视频").click()
        control(artifacts.video.title).click()
        val play = control("播放")
        assertTrue(play.visibleBounds.height() >= 48)
        assertFalse(device.hasObject(By.desc("媒体播放").pkg(app.packageName)))
        ScreenshotCapture.capture("video-phone.png")
        device.pressBack()
        control(artifacts.video.title)
        val filter = control("视频")
        assertTrue(filter.isSelected || filter.isChecked)

        node(By.desc("返回工作区")).click()
        node(By.text(artifacts.sourceTitle)).click()
        node(By.desc("聊天操作").enabled(true)).click()
        node(By.text("对话资料")).click()
        val resource = control(artifacts.summary.title)
        val resourcePosition = resource.visibleBounds
        resource.click()
        node(By.text("成果预览"))
        node(By.textContains("仅供预览"))
        node(By.textContains("帮助团队继续推进在手工作"))
        ScreenshotCapture.capture("chat-preview-phone.png")
        device.pressBack()
        assertEquals(resourcePosition, control(artifacts.summary.title).visibleBounds)
    }

    private fun captureWide(artifacts: ArtifactApiFixture) {
        val row = control(artifacts.summary.title)
        val rowPosition = row.visibleBounds
        row.click()
        node(By.textContains("仅供预览"))
        val source = control("查看来源对话")
        assertFalse(device.hasObject(By.text("保存文件").pkg(app.packageName)))
        assertTrue(rowPosition.right < source.visibleBounds.left)
        assertTrue(source.visibleBounds.height() >= 48)
        node(By.textContains("帮助团队继续推进在手工作"))
        ScreenshotCapture.capture("preview-wide.png")
        source.click()
        node(By.desc("返回成果预览")).click()
        control("查看来源对话")
        assertEquals(rowPosition, control(artifacts.summary.title).visibleBounds)
    }

    private fun control(label: String) =
        checkNotNull(generateSequence(node(By.text(label))) { it.parent }.firstOrNull { it.isClickable }) {
            "Missing clickable ancestor for $label"
        }

    private fun node(selector: BySelector) =
        checkNotNull(device.wait(Until.findObject(By.copy(selector).pkg(app.packageName)), 15_000)) {
            val labels = device.findObjects(By.pkg(app.packageName)).flatMap {
                listOfNotNull(it.text, it.contentDescription)
            }
            "Missing $selector among $labels"
        }

    private fun restoreDisplay(setting: String, previous: String) {
        val overrideValue = previous.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
        device.executeShellCommand("wm $setting ${overrideValue ?: "reset"}")
    }
}
