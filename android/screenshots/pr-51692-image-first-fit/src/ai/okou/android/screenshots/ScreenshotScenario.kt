package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatImageGalleryFixture
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
import android.graphics.Color
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun capturesFittedChatAndArtifactImages() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val oldPreferences = app.initialPreferences
        val oldApiPreferences = app.snapshotApiPreferences()
        val oldSize = device.executeShellCommand("wm size")
        val oldDensity = device.executeShellCommand("wm density")
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { api ->
            try {
                val image = app.resources.openRawResource(R.drawable.okou_conversation_avatar)
                    .use { it.readBytes() }
                val artifacts = ArtifactApiFixture(
                    api,
                    chinese = true,
                    imageBody = image,
                    imageDownloadAllowed = true,
                )
                artifacts.install()
                val gallery = ChatImageGalleryFixture(api)
                gallery.install()
                auth.state.value =
                    testAuthenticationState(user = "image-first-fit-${UUID.randomUUID()}")
                app.chatService = api.service
                app.initialPreferences =
                    testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("wm size 412x892")
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    activity.onActivity {
                        assertEquals(412, it.resources.configuration.screenWidthDp)
                        assertEquals(160, it.resources.configuration.densityDpi)
                    }
                    node(By.text(artifacts.sourceTitle))
                    tap(By.desc("成果"))
                    tap(By.text(artifacts.image.title))
                    node(By.desc("返回成果列表"))
                    node(By.desc(artifacts.image.title))
                    ScreenshotCapture.capture("artifact-image-fit.png")
                }
                ActivityScenario.launch(MainActivity::class.java).use {
                    tap(By.text(artifacts.sourceTitle))
                    node(By.text(gallery.prompt))
                    tap(By.desc(gallery.first))
                    node(By.desc("第 1 张，共 2 张"))
                    val viewport = node(By.desc(gallery.first)).visibleBounds
                    val screenshot = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
                    try {
                        val y = viewport.centerY() - viewport.width() / 5
                        val sky = Color.rgb(199, 224, 237)
                        assertEquals(sky, screenshot.getPixel(viewport.left + 17, y))
                        assertEquals(sky, screenshot.getPixel(viewport.right - 18, y))
                        assertNotEquals(sky, screenshot.getPixel(viewport.left + 14, y))
                        assertNotEquals(sky, screenshot.getPixel(viewport.right - 15, y))
                    } finally {
                        screenshot.recycle()
                    }
                    ScreenshotCapture.capture("chat-image-fit.png")
                }
            } finally {
                restoreDisplay("size", oldSize)
                restoreDisplay("density", oldDensity)
                auth.state.value = oldAuth
                app.chatService = oldService
                app.initialPreferences = oldPreferences
                app.restoreApiPreferences(oldApiPreferences)
                cache.restore()
            }
        }
    }

    private fun restoreDisplay(kind: String, output: String) {
        val override =
            output.lineSequence().firstOrNull { it.startsWith("Override ") }
                ?.substringAfter(": ")?.trim()
        device.executeShellCommand("wm $kind ${override ?: "reset"}")
    }

    private fun tap(selector: BySelector) {
        val bounds = node(selector).visibleBounds
        assertTrue(device.click(bounds.centerX(), bounds.centerY()))
    }

    private fun node(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(By.copy(selector).pkg(app.packageName)), 10_000)) {
            "Missing $selector"
        }
}
