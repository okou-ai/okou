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
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
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
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
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
    fun captureArtifactImageStates() {
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
            val bytes = sampleImage()
            val artifacts = ArtifactApiFixture(api, chinese = true, imageBody = bytes, imageDownloadAllowed = true)
            artifacts.install()
            try {
                auth.state.value =
                    testAuthenticationState(user = "artifact-image-${UUID.randomUUID()}")
                app.chatService = api.service
                app.initialPreferences = testPreferences().copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = UserPreferencesTheme.LIGHT,
                    timezone = "Asia/Shanghai",
                )
                app.connectivity.value = true
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                capture(412, 892, artifacts, bytes, deny = true)
                capture(1180, 820, artifacts, bytes, deny = false)
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

    private fun capture(width: Int, height: Int, artifacts: ArtifactApiFixture, bytes: ByteArray, deny: Boolean) {
        val release = CountDownLatch(1)
        val imageReads = AtomicInteger()
        artifacts.imageResponse = {
            release.await()
            when {
                !deny -> MockResponse().setBody(Buffer().write(bytes))
                imageReads.incrementAndGet() == 1 ->
                    MockResponse().setResponseCode(429).setHeader("Retry-After", "1")
                else -> MockResponse().setResponseCode(403)
            }
        }
        try {
            device.executeShellCommand("wm size ${width}x$height")
            ActivityScenario.launch(MainActivity::class.java).use { activity ->
                activity.onActivity {
                    assertEquals(width, it.resources.configuration.screenWidthDp)
                    assertEquals(160, it.resources.configuration.densityDpi)
                    assertEquals(1f, it.resources.configuration.fontScale, 0f)
                }
                see(By.text(artifacts.sourceTitle))
                tap(bounds(By.desc("成果")))
                see(By.text("全部"))
                tap(bounds(By.text("图片")))
                tap(bounds(By.text(artifacts.image.title)))
                see(By.text("正在加载预览"))
                see(By.text("保存文件"))
                ScreenshotCapture.capture(if (deny) "image-loading-phone.png" else "image-loading-wide.png")
                release.countDown()
                if (deny) {
                    see(By.text("图片不可用"))
                    assertEquals(2, imageReads.get())
                    assertFalse(device.hasObject(By.text("保存文件").pkg(app.packageName)))
                    ScreenshotCapture.capture("image-unavailable-phone.png")
                } else {
                    see(By.desc(artifacts.image.title))
                    see(By.text("保存文件"))
                    ScreenshotCapture.capture("image-ready-wide.png")
                }
                assertFalse(device.hasObject(By.text("正在加载预览").pkg(app.packageName)))
            }
        } finally {
            release.countDown()
        }
    }

    private fun sampleImage(): ByteArray {
        val bitmap = Bitmap.createBitmap(640, 440, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(bitmap)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            canvas.drawColor(0xffe9e3d5.toInt())
            paint.color = 0xff345b51.toInt()
            canvas.drawCircle(320f, 220f, 158f, paint)
            paint.color = 0xfff4b16e.toInt()
            canvas.drawCircle(320f, 181f, 51f, paint)
            paint.color = 0xfff4cf8d.toInt()
            canvas.drawRoundRect(229f, 241f, 411f, 307f, 33f, 33f, paint)
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            return out.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }

    private fun bounds(selector: BySelector): Rect = read(selector) { it.visibleBounds }

    private fun tap(bounds: Rect) {
        assertTrue(device.click(bounds.centerX(), bounds.centerY()))
    }

    private fun see(selector: BySelector) {
        val present = device.wait(Until.hasObject(selector.pkg(app.packageName)), 15_000)
        if (!present) runCatching { ScreenshotCapture.capture("diagnostic.png") }
        assertTrue("Missing $selector", present)
    }

    private fun <T : Any> read(selector: BySelector, snapshot: (UiObject2) -> T?): T {
        val scoped = By.copy(selector).pkg(app.packageName)
        val result = device.wait(object : SearchCondition<T>() {
            override fun apply(searchable: Searchable): T? =
                try {
                    searchable.findObject(scoped)?.let(snapshot)
                } catch (_: StaleObjectException) {
                    null
                }
        }, 15_000)
        if (result == null) runCatching { ScreenshotCapture.capture("diagnostic.png") }
        return checkNotNull(result) { "Could not read $selector" }
    }

    private fun restoreDisplay(setting: String, previous: String) {
        val overrideValue = previous.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
        device.executeShellCommand("wm $setting ${overrideValue ?: "reset"}")
    }
}
