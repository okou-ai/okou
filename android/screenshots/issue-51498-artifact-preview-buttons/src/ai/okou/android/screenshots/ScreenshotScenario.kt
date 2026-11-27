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
import androidx.test.uiautomator.UiObject2
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
    fun capturesOutlinedArtifactActionOnPhone() = capturePreview(412, 892, "phone")

    @Test
    fun capturesOutlinedArtifactActionInWideWindow() = capturePreview(1180, 820, "wide")

    private fun capturePreview(width: Int, height: Int, layout: String) =
        withWorkspace(width, height) { _, fixture, _ ->
            tap(By.desc("成果"))
            tap(By.text(fixture.summary.title))
            val source = generateSequence(node(By.text("查看来源对话"))) { it.parent }
                .first { it.isClickable }
            check(source.visibleBounds.height() >= 48)
            node(By.textContains("定位：帮助团队继续推进在手工作"))
            ScreenshotCapture.capture("artifact-preview-$layout.png")
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
                val fixture = ArtifactApiFixture(api, chinese = true)
                fixture.install()
                auth.state.value =
                    testAuthenticationState(user = "artifact-return-${UUID.randomUUID()}")
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
                        assertEquals(160, it.resources.configuration.densityDpi)
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
