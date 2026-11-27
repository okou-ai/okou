package ai.okou.android.screenshots

import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.view.WindowInsets
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import okhttp3.mockwebserver.MockResponse
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val subject = By.clazz("android.widget.EditText").hasDescendant(By.desc("Subject contains"))
    private val save = By.text("Save")
    private val draft = "Release summary"

    @Test
    fun workflowEditorKeepsFieldsAndActionsReachable() {
        val initialSize = displayOverride("size", "\\d+x\\d+")
        val initialDensity = displayOverride("density", "\\d+")
        val initialScale = device.executeShellCommand("settings get system font_scale").trim()
        val initialIme = device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        val timeoutSetting = "accessibility_non_interactive_ui_timeout_ms"
        val initialTimeout = device.executeShellCommand("settings get secure $timeoutSetting").trim()
        val failures = mutableListOf<Throwable>()
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 0")
            device.executeShellCommand("settings put secure $timeoutSetting 30000")
            captureWindow(412, 892, 1f, UserPreferencesTheme.LIGHT) { scenario, fixture ->
                closeIme(scenario)
                device.executeShellCommand("wm size 360x280")
                device.executeShellCommand("settings put system font_scale 2.0")
                assertWindow(scenario, 360, 280, 2f)
                closeIme(scenario)
                reveal(scenario, subject, minimumHeight = 70)
                val field = node(subject).visibleBounds
                val viewport = editorViewport()
                val remaining = field.top - viewport.top
                if (remaining > 8) scrollEditor(viewport, remaining + 4, safeBottom(scenario))
                assertEquals(draft, node(subject).text)
                ScreenshotCapture.capture("short-editor-fields.png")
                reveal(scenario, save)
                assertFooter(scenario)
                ScreenshotCapture.capture("short-editor-actions.png")

                val original = fixture.chats.commandResponse
                fixture.chats.commandResponse = { request ->
                    if (request.requestUrl?.encodedPath == "/api/connectors/connected")
                        MockResponse().setResponseCode(400)
                    else original(request)
                }
                val saveBounds = checkNotNull(saveControl(node(save))).visibleBounds
                scenario.moveToState(Lifecycle.State.STARTED)
                scenario.moveToState(Lifecycle.State.RESUMED)
                val noticeBounds = node(By.text("Could not refresh. Showing last loaded data.")).visibleBounds
                assertTrue(
                    "Read feedback is visible above system insets",
                    noticeBounds.height() > 0 && noticeBounds.bottom <= safeBottom(scenario),
                )
                captureSnackbarSurface(noticeBounds)
                assertEquals(saveBounds, checkNotNull(saveControl(node(save))).visibleBounds)
            }
        } catch (failure: Throwable) {
            failures += failure
        } finally {
            listOf(
                "wm size ${initialSize ?: "reset"}",
                "wm density ${initialDensity ?: "reset"}",
                if (initialScale.toFloatOrNull() == null) "settings delete system font_scale"
                else "settings put system font_scale $initialScale",
                if (initialIme.toIntOrNull() == null) "settings delete secure show_ime_with_hard_keyboard"
                else "settings put secure show_ime_with_hard_keyboard $initialIme",
                if (initialTimeout.toIntOrNull() == null) "settings delete secure $timeoutSetting"
                else "settings put secure $timeoutSetting $initialTimeout",
            ).forEach { command ->
                try {
                    device.executeShellCommand(command)
                } catch (failure: Throwable) {
                    failures += failure
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private fun captureWindow(
        width: Int,
        height: Int,
        scale: Float,
        theme: UserPreferencesTheme,
        capture: (ActivityScenario<MainActivity>, WorkflowApiFixture) -> Unit,
    ) {
        WorkflowApiFixture().use { fixture ->
            val connectorFixture = ConnectorApiFixture()
            val originalPreferences = app.initialPreferences
            val preferenceData = app.snapshotApiPreferences()
            val auth = app.authentication as TestAuthentication
            val originalAuth = auth.state.value
            val originalChats = app.chatService
            val originalComposer = app.composerService
            val originalWorkflows = app.workflows
            val originalConnectors = app.connectorService
            try {
                device.executeShellCommand("wm size ${width}x${height}")
                device.executeShellCommand("settings put system font_scale $scale")
                app.chatService = fixture.service
                app.composerService = fixture.service
                app.workflows = fixture.service
                app.connectorService = connectorFixture.service
                app.restoreApiPreferences(emptyMap())
                app.initialPreferences =
                    testPreferences().copy(locale = UserPreferencesLocale.EN_US, theme = theme)
                auth.state.value = testAuthenticationState(user = "user-a", session = UUID.randomUUID().toString())
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    try {
                        assertWindow(scenario, width, height, scale)
                        node(By.desc("Workflows").enabled(true)).click()
                        action(By.text(fixture.releaseTitle)).click()
                        action(By.text("Automations")).click()
                        action(By.text("Add automation")).click()
                        action(By.text("Event")).click()
                        action(By.text("Google Calendar · Event created")).click()
                        action(By.text("Gmail · Message received")).click()
                        reveal(scenario, subject)
                        node(subject).text = draft
                        assertEquals(draft, node(subject).text)
                        capture(scenario, fixture)
                    } catch (failure: Throwable) {
                        runCatching {
                            TestStorage().openOutputFile("workflow-editor-failure.xml").use(device::dumpWindowHierarchy)
                        }
                        runCatching { ScreenshotCapture.capture("workflow-editor-failure.png") }
                        throw failure
                    }
                }
            } finally {
                app.chatService = originalChats
                app.composerService = originalComposer
                app.workflows = originalWorkflows
                app.connectorService = originalConnectors
                auth.state.value = originalAuth
                app.initialPreferences = originalPreferences
                app.restoreApiPreferences(preferenceData)
                connectorFixture.close()
            }
        }
    }

    private fun assertWindow(scenario: ActivityScenario<MainActivity>, width: Int, height: Int, scale: Float) {
        val matches = object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean {
                var matches = false
                scenario.onActivity {
                    val config = it.resources.configuration
                    val bounds = it.windowManager.currentWindowMetrics.bounds
                    matches = config.densityDpi == 160 && config.fontScale == scale &&
                        bounds.width() == width && bounds.height() == height
                }
                return matches
            }
        }
        assertTrue("Window ${width}x${height}, font scale $scale", device.wait(matches, 10_000))
    }

    private fun assertFooter(scenario: ActivityScenario<MainActivity>) {
        val control = checkNotNull(saveControl(node(save))) { "Disabled Save must have a 48 dp target" }
        val area = control.visibleBounds
        assertTrue("Save preserved its target: $area", area.height() >= 48)
        assertTrue("Save needs a connection", !control.isEnabled)
        assertTrue(area.bottom <= safeBottom(scenario))
        assertTrue(action(By.text("View connections")).isEnabled)
    }

    private fun saveControl(label: UiObject2): UiObject2? =
        generateSequence(label) { it.parent }.firstOrNull {
            !it.isEnabled && it.visibleBounds.height() >= 48
        }

    private fun safeBottom(scenario: ActivityScenario<MainActivity>): Int {
        var bottom = 0
        scenario.onActivity {
            val bars = checkNotNull(it.window.decorView.rootWindowInsets)
            bottom = it.windowManager.currentWindowMetrics.bounds.bottom -
                bars.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime()).bottom
        }
        return bottom
    }

    private fun closeIme(scenario: ActivityScenario<MainActivity>) {
        fun imeVisible(): Boolean {
            var visible = false
            scenario.onActivity {
                visible = it.window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true
            }
            return visible
        }
        if (!imeVisible()) return
        assertTrue(device.pressBack())
        val hidden = object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean = !imeVisible()
        }
        assertTrue("The keyboard closes before capturing the resized form", device.wait(hidden, 10_000))
    }

    private fun reveal(
        scenario: ActivityScenario<MainActivity>,
        selector: BySelector,
        minimumHeight: Int = 32,
    ) {
        val scoped = By.copy(selector).pkg(app.packageName)
        var largestVisibleHeight = 0
        repeat(28) {
            closeIme(scenario)
            val node = device.findObject(scoped)
            val target = if (selector === save) node?.let(::saveControl) else node
            val bottom = safeBottom(scenario)
            largestVisibleHeight = maxOf(largestVisibleHeight, target?.visibleBounds?.height() ?: 0)
            if (target != null && target.visibleBounds.height() >= minimumHeight &&
                target.visibleBounds.bottom <= bottom
            ) return
            val drag = if (selector === save) 68 else if (target == null) 46 else 24
            scrollEditor(editorViewport(), drag, bottom)
        }
        error("Could not reveal $selector, largest visible height was $largestVisibleHeight px")
    }

    private fun editorViewport(): Rect =
        device.findObjects(By.scrollable(true).pkg(app.packageName))
            .map { it.visibleBounds }
            .filter { it.height() >= 48 }
            .minByOrNull { it.height() }
            ?: error("No scrollable editor viewport")

    private fun scrollEditor(viewport: Rect, distance: Int, safeBottom: Int) {
        val x = viewport.left + 14
        val start = minOf(safeBottom, viewport.bottom) - 12
        val end = maxOf(viewport.top + 12, start - distance)
        assertTrue(device.swipe(x, start, x, end, 60))
        device.waitForIdle()
    }

    private fun captureSnackbarSurface(bounds: Rect) {
        val painted = object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean {
                val frame = instrumentation.uiAutomation.takeScreenshot() ?: return false
                return try {
                    val inverseSurface = 0xff362f27.toInt()
                    val surfaceSamples = (bounds.top until bounds.bottom step 4).sumOf { y ->
                        (bounds.left until bounds.right step 4).count { x ->
                            frame.getPixel(x, y) == inverseSurface
                        }
                    }
                    if (surfaceSamples < 80) return false
                    writeSnackbarFrame(frame)
                    true
                } finally {
                    frame.recycle()
                }
            }
        }
        assertTrue("The short editor Snackbar has drawn its inverse surface", device.wait(painted, 4_000))
    }

    private fun writeSnackbarFrame(frame: Bitmap) {
        val name = "short-editor-feedback.png"
        // Keep the actual frame that satisfied the paint condition before the Snackbar times out.
        TestStorage().openOutputFile(name).use {
            check(frame.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        val config = instrumentation.targetContext.resources.configuration
        val metadata = JSONObject()
            .put("runId", checkNotNull(InstrumentationRegistry.getArguments().getString("okouScreenshotRun")))
            .put("api", Build.VERSION.SDK_INT)
            .put("device", Build.MODEL)
            .put("locale", config.locales.toLanguageTags())
            .put("densityDpi", config.densityDpi)
            .put("fontScale", config.fontScale)
            .put("nightMode", config.uiMode and Configuration.UI_MODE_NIGHT_MASK)
            .put("width", frame.width)
            .put("height", frame.height)
        TestStorage().openOutputFile("$name.json").use {
            it.write(metadata.toString().toByteArray(Charsets.UTF_8))
        }
    }

    private fun node(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(By.copy(selector).pkg(app.packageName)), 10_000)) {
            "Missing workflow selector $selector"
        }

    private fun action(selector: BySelector): UiObject2 =
        checkNotNull(generateSequence(node(selector)) { it.parent }.firstOrNull { it.isClickable })

    private fun displayOverride(setting: String, pattern: String): String? =
        Regex("Override $setting: ($pattern)").find(device.executeShellCommand("wm $setting"))?.groupValues?.get(1)
}
