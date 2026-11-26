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
import android.graphics.Color
import android.graphics.Rect
import android.util.Base64
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.SearchCondition
import androidx.test.uiautomator.Searchable
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
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
    fun capturesArtifactImageViewer() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val oldPreferences = app.initialPreferences
        val oldApiPreferences = app.snapshotApiPreferences()
        val oldSize = device.executeShellCommand("wm size")
        val oldDensity = device.executeShellCommand("wm density")
        val oldScale = device.executeShellCommand("settings get system font_scale").trim()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { api ->
            try {
                val artwork = Base64.decode(avatarRaster, Base64.DEFAULT)
                val fixture = ArtifactApiFixture(api, chinese = true, imageDownloadAllowed = true)
                val original = AtomicReference<ByteArray?>(artwork)
                fixture.imageResponse = {
                    original.get()?.let { bytes ->
                        MockResponse()
                            .setHeader("Content-Type", if (bytes === artwork) "image/png" else "image/jpeg")
                            .setBody(Buffer().write(bytes))
                    } ?: MockResponse().setResponseCode(404)
                }
                fixture.install()
                auth.state.value = testAuthenticationState(user = "artifact-image-${UUID.randomUUID()}")
                app.chatService = api.service
                app.initialPreferences = testPreferences().copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = UserPreferencesTheme.LIGHT,
                    timezone = "Asia/Shanghai",
                )
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                device.executeShellCommand("wm size 412x892")
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    activity.onActivity { assertEquals(412, it.resources.configuration.screenWidthDp) }
                    openArtifact(fixture)
                    val back = node(By.desc("返回成果列表")).visibleBounds
                    val actions = node(By.desc("图片操作")).visibleBounds
                    assertEquals(48, back.width())
                    assertEquals(48, actions.height())
                    assertEquals(12, back.left)
                    assertEquals(12, 412 - actions.right)
                    val image = awaitOriginal(fixture)
                    assertEquals(16, image.visibleBounds.left)
                    assertEquals(16, 412 - image.visibleBounds.right)
                    ScreenshotCapture.capture("artifact-image-phone-fit.png")

                    image.pinchOpen(0.8f)
                    waitForFitAction()
                    device.waitForIdle()
                    ScreenshotCapture.capture("artifact-image-phone-zoomed.png")
                    device.pressBack()
                    node(By.text(fixture.image.title))
                    tap(By.text(fixture.image.title))
                    awaitOriginal(fixture)
                    assertTrue(!hasAction(instrumentation.uiAutomation.rootInActiveWindow, "适屏"))
                    device.pressBack()
                    original.set(null)
                    tap(By.text(fixture.image.title))
                    node(By.text("原图不可用"))
                    node(By.desc(fixture.image.title))
                    assertTrue(!device.hasObject(By.desc("图片操作").pkg(app.packageName)))
                    device.pressBack()
                    original.set(Base64.decode(orientedRaster, Base64.DEFAULT))
                    tap(By.text(fixture.image.title))
                    awaitOrientedPhoto(node(By.desc(fixture.image.title)).visibleBounds)
                    original.set(artwork)
                }

                device.executeShellCommand("wm size 1180x820")
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    activity.onActivity { assertEquals(1180, it.resources.configuration.screenWidthDp) }
                    openArtifact(fixture)
                    val pane = awaitOriginal(fixture)
                    val paneWidth = pane.visibleBounds.width()
                    val expand = node(By.desc("展开图片查看器")).visibleBounds
                    val overflow = node(By.desc("图片操作")).visibleBounds
                    assertEquals(4, overflow.left - expand.right)
                    pane.pinchOpen(0.8f)
                    waitForFitAction()
                    device.waitForIdle()
                    ScreenshotCapture.capture("artifact-image-wide-pane.png")
                    tap(By.desc("展开图片查看器"))
                    node(By.desc("收起图片查看器"))
                    assertTrue(node(By.desc(fixture.image.title)).visibleBounds.width() > paneWidth)
                    waitForFitAction()
                    activity.recreate()
                    node(By.desc("收起图片查看器"))
                    awaitOriginal(fixture)
                    waitForFitAction()
                    ScreenshotCapture.capture("artifact-image-wide-expanded.png")
                    device.pressBack()
                    node(By.desc("展开图片查看器"))
                    waitForFitAction()
                }
            } catch (error: Throwable) {
                runCatching { ScreenshotCapture.capture("diagnostic.png") }
                throw error
            } finally {
                restoreDisplay("size", oldSize)
                restoreDisplay("density", oldDensity)
                if (oldScale.toFloatOrNull() == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else device.executeShellCommand("settings put system font_scale $oldScale")
                auth.state.value = oldAuth
                app.chatService = oldService
                app.initialPreferences = oldPreferences
                app.restoreApiPreferences(oldApiPreferences)
                cache.restore()
            }
        }
    }

    private fun openArtifact(fixture: ArtifactApiFixture) {
        node(By.text(fixture.sourceTitle))
        tap(By.desc("成果"))
        tap(By.text(fixture.image.title))
    }

    private fun awaitOriginal(fixture: ArtifactApiFixture): UiObject2 {
        val selector = By.desc(fixture.image.title)
        val image = node(selector)
        val bounds = image.visibleBounds
        check(device.wait(object : SearchCondition<Boolean>() {
            override fun apply(searchable: Searchable): Boolean = hasAvatarColors(bounds)
        }, 12_000) == true) { "Expected the decoded avatar in the image viewport" }
        return node(selector)
    }

    private fun hasAvatarColors(bounds: Rect): Boolean {
        val frame = instrumentation.uiAutomation.takeScreenshot() ?: return false
        try {
            for (y in bounds.top.coerceAtLeast(0) until minOf(bounds.bottom, frame.height) step 16) {
                for (x in bounds.left.coerceAtLeast(0) until minOf(bounds.right, frame.width) step 16) {
                    val pixel = frame.getPixel(x, y)
                    val r = Color.red(pixel)
                    val g = Color.green(pixel)
                    val b = Color.blue(pixel)
                    val blue = b >= 160 && r < 80 && g < 140
                    val orange = r > 220 && g in 105..185 && b < 50
                    if (blue || orange) return true
                }
            }
            return false
        } finally {
            frame.recycle()
        }
    }

    private fun awaitOrientedPhoto(bounds: Rect) {
        check(device.wait(object : SearchCondition<Boolean>() {
            override fun apply(searchable: Searchable): Boolean {
                val frame = instrumentation.uiAutomation.takeScreenshot() ?: return false
                try {
                    val left = frame.getPixel(bounds.left + bounds.width() / 4, bounds.centerY())
                    val right = frame.getPixel(bounds.right - bounds.width() / 4, bounds.centerY())
                    return Color.blue(left) > 180 && Color.red(left) < 70 &&
                        Color.red(right) > 200 && Color.blue(right) < 65
                } finally {
                    frame.recycle()
                }
            }
        }, 12_000) == true) { "The original JPEG did not display its EXIF orientation" }
    }

    private fun waitForFitAction() {
        check(device.wait(object : SearchCondition<Boolean>() {
            override fun apply(searchable: Searchable): Boolean =
                hasAction(instrumentation.uiAutomation.rootInActiveWindow, "适屏")
        }, 10_000) == true) { "Expected a zoomed image with an accessible fit action" }
    }

    private fun hasAction(node: AccessibilityNodeInfo?, label: String): Boolean =
        node != null && (
            node.actionList.any { it.label?.toString() == label } ||
                (0 until node.childCount).any { hasAction(node.getChild(it), label) }
            )

    private fun tap(selector: BySelector) {
        val bounds = node(selector).visibleBounds
        assertTrue(device.click(bounds.centerX(), bounds.centerY()))
    }

    private fun node(selector: BySelector): UiObject2 {
        val scoped = By.copy(selector).pkg(app.packageName)
        return checkNotNull(device.wait(Until.findObject(scoped), 15_000)) { "Missing $selector" }
    }

    private fun restoreDisplay(setting: String, previous: String) {
        val value = previous.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
        device.executeShellCommand("wm $setting ${value ?: "reset"}")
    }
}
