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
import android.graphics.Rect
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.SearchCondition
import androidx.test.uiautomator.Searchable
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
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
            see(By.text(artifacts.sourceTitle))
            tap(By.desc("成果").enabled(true))
            val today = read(By.text("今天")) { it.visibleBounds }
            val yesterday = read(By.text("昨天")) { it.visibleBounds }
            val earlier = read(By.text("更早")) { it.visibleBounds }
            assertTrue(today.bottom < yesterday.top)
            assertTrue(yesterday.bottom < earlier.top)
            block()
        }
    }

    private fun capturePhone(artifacts: ArtifactApiFixture) {
        val avatarPosition = bounds(By.text(artifacts.image.title))
        ScreenshotCapture.capture("catalog-phone.png")
        tap(By.text(artifacts.image.title))
        see(By.text("此文件暂不支持预览"))
        ScreenshotCapture.capture("unavailable-phone.png")
        tap(By.desc("返回成果列表"))
        assertEquals(avatarPosition, bounds(By.text(artifacts.image.title)))
        tap(By.text("视频"))
        tap(By.text(artifacts.video.title))
        assertTrue(actionBounds("播放").height() >= 48)
        assertFalse(device.hasObject(By.desc("媒体播放").pkg(app.packageName)))
        ScreenshotCapture.capture("video-phone.png")
        device.pressBack()
        see(By.text(artifacts.video.title))
        assertFalse(device.hasObject(By.text(artifacts.summary.title).pkg(app.packageName)))

        tap(By.desc("返回工作区"))
        tap(By.text(artifacts.sourceTitle))
        tap(By.desc("聊天操作").enabled(true))
        tap(By.text("对话资料"))
        val resourcePosition = bounds(By.text(artifacts.summary.title))
        tap(By.text(artifacts.summary.title))
        see(By.text("成果预览"))
        see(By.textContains("仅供预览"))
        see(By.textContains("帮助团队继续推进在手工作"))
        ScreenshotCapture.capture("chat-preview-phone.png")
        device.pressBack()
        assertEquals(resourcePosition, bounds(By.text(artifacts.summary.title)))
    }

    private fun captureWide(artifacts: ArtifactApiFixture) {
        val rowPosition = bounds(By.text(artifacts.summary.title))
        tap(By.text(artifacts.summary.title))
        see(By.textContains("仅供预览"))
        val source = actionBounds("查看来源对话")
        assertFalse(device.hasObject(By.text("保存文件").pkg(app.packageName)))
        assertTrue(rowPosition.right < source.left)
        assertTrue(source.height() >= 48)
        see(By.textContains("帮助团队继续推进在手工作"))
        ScreenshotCapture.capture("preview-wide.png")
        tap(By.text("查看来源对话"))
        tap(By.desc("返回成果预览"))
        see(By.text("查看来源对话"))
        assertEquals(rowPosition, bounds(By.text(artifacts.summary.title)))
    }

    private fun bounds(selector: BySelector): Rect = read(selector) { it.visibleBounds }

    private fun actionBounds(label: String): Rect =
        read(By.text(label)) { text ->
            generateSequence(text) { it.parent }.firstOrNull { it.isClickable }?.visibleBounds
        }

    private fun tap(selector: BySelector) {
        val bounds = bounds(selector)
        assertTrue(device.click(bounds.centerX(), bounds.centerY()))
    }

    private fun see(selector: BySelector) {
        assertTrue("Missing $selector", device.wait(Until.hasObject(By.copy(selector).pkg(app.packageName)), 15_000))
    }

    private fun <T : Any> read(selector: BySelector, snapshot: (UiObject2) -> T?): T {
        val scoped = By.copy(selector).pkg(app.packageName)
        return checkNotNull(device.wait(object : SearchCondition<T>() {
            override fun apply(searchable: Searchable): T? {
                return try {
                    searchable.findObject(scoped)?.let(snapshot)
                } catch (_: StaleObjectException) {
                    null
                }
            }
        }, 15_000)) {
            "Could not read a stable accessibility node for $selector"
        }
    }

    private fun restoreDisplay(setting: String, previous: String) {
        val overrideValue = previous.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
        device.executeShellCommand("wm $setting ${overrideValue ?: "reset"}")
    }
}
