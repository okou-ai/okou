package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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

    @Test fun capturesThumbnailReplacementOnPhone() = captureRefresh(412, 892, "phone")

    @Test
    fun capturesThumbnailReplacementBesideASelectedArtifact() = captureRefresh(1180, 820, "wide")

    private fun captureRefresh(width: Int, height: Int, layout: String) =
        withWorkspace(width, height) { api, fixture, activity ->
            val requested = CountDownLatch(1)
            val release = CountDownLatch(1)
            fixture.imageResponse = {
                requested.countDown()
                check(release.await(16, TimeUnit.SECONDS))
                MockResponse().setBody(Buffer().write(encodeImage(R.drawable.workspace_default_1)))
            }
            try {
                tap(By.desc("成果"))
                if (layout == "wide") {
                    tap(By.text(fixture.summary.title))
                    node(By.textContains("定位"))
                }
                val selector = By.text(fixture.image.title)
                val row = node(selector).visibleBounds
                awaitPixels("Original thumbnail did not appear") { image ->
                    thumbnailHasColor(image, row.top, row.bottom) {
                        Color.blue(it) > 120 && Color.blue(it) - Color.red(it) > 50
                    }
                }
                if (layout == "phone")
                    ScreenshotCapture.capture("artifact-thumbnail-original-phone.png")

                fixture.imageThumbnailUrl =
                    api.server.url("/artifact-bytes/image-preview").toString()
                activity.moveToState(Lifecycle.State.CREATED)
                activity.moveToState(Lifecycle.State.RESUMED)
                assertTrue(requested.await(10, TimeUnit.SECONDS))
                awaitPixels("The previous thumbnail is still visible") { image ->
                    !thumbnailHasColor(image, row.top, row.bottom) {
                        Color.blue(it) > 120 && Color.blue(it) - Color.red(it) > 50
                    }
                }
                assertEquals(row, node(selector).visibleBounds)
                if (layout == "wide") node(By.textContains("定位"))
                ScreenshotCapture.capture("artifact-thumbnail-pending-$layout.png")

                release.countDown()
                awaitPixels("Replacement thumbnail did not appear") { image ->
                    thumbnailHasColor(image, row.top, row.bottom) {
                        Color.red(it) > 190 && Color.green(it) < 115 && Color.blue(it) < 100
                    }
                }
                assertEquals(row, node(selector).visibleBounds)
                if (layout == "wide") node(By.textContains("定位"))
                ScreenshotCapture.capture("artifact-thumbnail-replaced-$layout.png")
            } finally {
                release.countDown()
            }
        }

    private fun thumbnailHasColor(
        image: Bitmap,
        rowTop: Int,
        rowBottom: Int,
        condition: (Int) -> Boolean,
    ): Boolean =
        ((rowTop - 8) until rowBottom).any { y ->
            (32 until 64).any { x -> condition(image.getPixel(x, y)) }
        }

    private fun awaitPixels(message: String, matches: (Bitmap) -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            val screenshot = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            try {
                if (matches(screenshot)) return
            } finally {
                screenshot.recycle()
            }
            SystemClock.sleep(40)
        }
        error(message)
    }

    private fun withWorkspace(
        width: Int,
        height: Int,
        block: (ChatListApiFixture, ArtifactApiFixture, ActivityScenario<MainActivity>) -> Unit,
    ) {
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
                val fixture =
                    ArtifactApiFixture(
                        api,
                        chinese = true,
                        imageBody = encodeImage(R.drawable.okou_conversation_avatar),
                    )
                fixture.install()
                auth.state.value =
                    testAuthenticationState(user = "artifact-thumbnail-${UUID.randomUUID()}")
                app.chatService = api.service
                app.initialPreferences =
                    testPreferences()
                        .copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = UserPreferencesTheme.LIGHT,
                            timezone = "Asia/Shanghai",
                        )
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("wm size ${width}x$height")
                device.executeShellCommand("settings put system font_scale 1.0")
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    activity.onActivity {
                        assertEquals(width, it.resources.configuration.screenWidthDp)
                        assertEquals(1f, it.resources.configuration.fontScale, 0f)
                    }
                    node(By.text(fixture.sourceTitle))
                    try {
                        block(api, fixture, activity)
                    } catch (error: Throwable) {
                        runCatching { ScreenshotCapture.capture("diagnostic-$width.png") }
                        throw error
                    }
                }
            } finally {
                restoreDisplay("size", oldSize)
                restoreDisplay("density", oldDensity)
                if (oldScale.toFloatOrNull() == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else {
                    device.executeShellCommand("settings put system font_scale $oldScale")
                }
                auth.state.value = oldAuth
                app.chatService = oldService
                app.initialPreferences = oldPreferences
                app.restoreApiPreferences(oldApiPreferences)
                cache.restore()
            }
        }
    }

    private fun encodeImage(drawable: Int): ByteArray {
        val bitmap = BitmapFactory.decodeResource(app.resources, drawable)
        return try {
            ByteArrayOutputStream().use { output ->
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
                output.toByteArray()
            }
        } finally {
            bitmap.recycle()
        }
    }

    private fun restoreDisplay(kind: String, output: String) {
        val override =
            output
                .lineSequence()
                .firstOrNull { it.startsWith("Override ") }
                ?.substringAfter(": ")
                ?.trim()
        device.executeShellCommand("wm $kind ${override ?: "reset"}")
    }

    private fun tap(selector: BySelector) {
        val bounds = node(selector).visibleBounds
        assertTrue(device.click(bounds.centerX(), bounds.centerY()))
    }

    private fun node(selector: BySelector, timeout: Long = 10_000): UiObject2 =
        checkNotNull(
            device.wait(Until.findObject(By.copy(selector).pkg(app.packageName)), timeout),
        ) {
            "Missing $selector"
        }
}
