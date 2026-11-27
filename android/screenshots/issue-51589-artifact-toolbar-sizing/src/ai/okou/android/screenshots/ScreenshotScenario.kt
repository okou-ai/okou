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
import ai.okou.android.auth.SessionModel
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.os.SystemClock
import android.view.KeyEvent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.StaleObjectException
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
    fun returnsToTheNearestArtifactOnPhone() = captureReturn(412, 892, "phone")

    @Test
    fun returnsToTheNearestArtifactInAWideCatalog() = captureReturn(1180, 820, "wide")

    private fun captureReturn(width: Int, height: Int, layout: String) =
        withWorkspace(width, height) { _, fixture, activity ->
            val image = By.text(fixture.image.title)
            val destination = By.text(fixture.slides.title)
            try {
                tap(By.desc("成果"))
                val originalBounds = clickTarget(image).visibleBounds
                val neighborBounds = clickTarget(destination).visibleBounds
                assertEquals(72, neighborBounds.height())
                assertEquals(16, neighborBounds.left)
                check(neighborBounds.top < originalBounds.top)
                instrumentation.setInTouchMode(false)
                for (step in 0 until 20) {
                    if (isFocused(image)) break
                    check(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
                    device.waitForIdle(180)
                }
                check(isFocused(image)) { "Could not reach the original image with Tab" }
                check(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
                node(By.desc("返回成果列表"))
                ScreenshotCapture.capture("artifact-image-toolbar-$layout.png")

                fixture.removedCatalogIds = setOf(fixture.image.id)
                activity.moveToState(Lifecycle.State.CREATED)
                activity.moveToState(Lifecycle.State.RESUMED)
                await("The confirmed catalog did not remove the original image") {
                    var removed = false
                    activity.onActivity {
                        val model = ViewModelProvider(it)[SessionModel::class.java]
                        val page = model.uiState.value.ready?.artifacts?.state?.value?.page
                        removed = page?.items?.none { row -> row.id == fixture.image.id } == true
                    }
                    removed
                }
                check(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
                activity.onActivity {
                    check(!it.window.decorView.isInTouchMode) { "Preview did not enter keyboard mode" }
                }
                assertTrue(device.pressBack())

                await("The nearest result did not receive keyboard focus") {
                    isFocused(destination)
                }
                check(!device.hasObject(By.copy(image).pkg(app.packageName)))
                assertEquals(neighborBounds, clickTarget(destination).visibleBounds)
                ScreenshotCapture.capture("artifact-return-focus-$layout.png")

                tap(By.text(fixture.summary.title))
                val source = clickTarget(By.text("查看来源对话"))
                check(source.visibleBounds.height() >= 48)
                node(By.textContains("定位：帮助团队继续推进在手工作"))
                ScreenshotCapture.capture("artifact-preview-$layout.png")
            } finally {
                instrumentation.resetInTouchMode()
            }
        }

    private fun clickTarget(selector: BySelector): UiObject2 =
        generateSequence(node(selector)) { it.parent }.first { it.isClickable }

    private fun isFocused(selector: BySelector): Boolean {
        repeat(3) {
            try {
                val row = device.findObject(By.copy(selector).pkg(app.packageName))
                return generateSequence(row) { it.parent }.any { it.isFocused }
            } catch (_: StaleObjectException) {
                // Keyboard insets can replace nodes while Tab moves through the catalog.
            }
        }
        return false
    }

    private fun await(message: String, ready: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (ready()) return
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
