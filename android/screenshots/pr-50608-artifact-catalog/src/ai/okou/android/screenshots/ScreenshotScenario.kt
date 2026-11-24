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
import ai.okou.android.awaitKeyboardFocus
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Rect
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
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
    fun captureArtifactCatalogBrowsing() {
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
                instrumentation.resetInTouchMode()
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
        ScreenshotCapture.capture("catalog-phone.png")
        tap(By.text("文件"))
        val query = By.desc("搜索成果")
        focusWithTab(query)
        device.executeShellCommand("input text unmatched")
        assertTrue(
            "The catalog did not receive the keyword typed into the focused native field",
            device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean =
                    artifacts.catalogQueries.any { (_, keyword) -> keyword == "unmatched" }
            }, 15_000),
        )
        see(By.text("没有匹配的成果"))
        assertTrue(actionBounds("清除关键词").height() >= 48)
        ScreenshotCapture.capture("empty-search-phone.png")
        focusWithTab(By.text("清除关键词"))
        assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
        see(By.text(artifacts.checklist.title))
        see(By.text("昨天"))
        verifyFocus(query)
        tap(By.text("视频"))
        see(By.text("此分类暂无成果"))
        assertTrue(actionBounds("查看全部").height() >= 48)
        ScreenshotCapture.capture("empty-filter-phone.png")
        focusWithTab(By.text("查看全部"))
        assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
        see(By.text(artifacts.image.title))
        verifyFocus(By.text("全部"))
    }

    private fun captureWide(artifacts: ArtifactApiFixture) {
        val videos = By.text("视频")
        instrumentation.setInTouchMode(false)
        focusWithTab(By.text("全部"))
        for (label in listOf("文件", "网站", "图片", "演示文稿", "视频")) {
            assertTrue(device.pressDPadRight())
            verifyFocus(By.text(label))
        }
        assertTrue(actionBounds("视频").width() >= 48)
        ScreenshotCapture.capture("filter-focus-wide.png")
        assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
        see(By.text("此分类暂无成果"))
        focusWithTab(By.text("查看全部"))
        assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
        verifyFocus(By.text("全部"))
        see(By.text(artifacts.summary.title))

        val row = By.text(artifacts.summary.title).clickable(true)
        focusWithTab(row)
        val rowPosition = bounds(row)
        assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
        see(By.textContains("仅供预览"))
        verifyFocus(row)
        val source = actionBounds("查看来源对话")
        assertTrue(rowPosition.right < source.left)
        assertTrue(source.height() >= 48)
        assertFalse(device.hasObject(By.text("保存文件").pkg(app.packageName)))
        see(By.textContains("帮助团队继续推进在手工作"))
        ScreenshotCapture.capture("selected-preview-wide.png")
        tap(By.text("查看来源对话"))
        tap(By.desc("返回成果预览"))
        see(By.text("查看来源对话"))
        assertEquals(rowPosition, bounds(row))
    }

    private fun focusWithTab(selector: BySelector) {
        val scoped = By.copy(selector).pkg(app.packageName)
        val focused = By.copy(scoped).focused(true)
        val focusedControl = By.focused(true).hasChild(scoped)
        val trail = mutableListOf<String?>()
        fun reached() = device.hasObject(focused) || device.hasObject(focusedControl)
        repeat(18) {
            if (reached()) return
            val before = focusName()
            trail.add(before)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
            device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean = reached() || focusName() != before
            }, 1_500)
        }
        if (!reached()) runCatching { ScreenshotCapture.capture("tab-diagnostic.png") }
        check(reached()) { "Tab did not reach $selector. Focus trail: $trail" }
    }

    private fun focusName(): String? = try {
        device.findObject(By.pkg(app.packageName).focused(true))?.let { node ->
            node.text ?: node.contentDescription ?: node.children.firstOrNull()?.text
        }
    } catch (_: StaleObjectException) {
        null
    }

    private fun verifyFocus(selector: BySelector) {
        try {
            device.awaitKeyboardFocus(By.copy(selector).pkg(app.packageName))
        } catch (error: IllegalStateException) {
            runCatching { ScreenshotCapture.capture("focus-diagnostic.png") }
            throw IllegalStateException("Expected $selector. Observed focus on ${focusName()}", error)
        }
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
        val present = device.wait(Until.hasObject(By.copy(selector).pkg(app.packageName)), 15_000)
        if (!present) runCatching { ScreenshotCapture.capture("diagnostic.png") }
        assertTrue("Missing $selector", present)
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
