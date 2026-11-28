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
import android.graphics.Rect
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
    private val save = By.text("Save")
    private val dismiss = By.desc("Dismiss")
    private val viewConnections = By.text("View connections")
    private val use = By.text("Use in chat")
    private val subject = By.clazz("android.widget.EditText").hasDescendant(By.desc("Subject contains"))

    @Test
    fun captureRegularWorkflowPanes() = withDeviceSettings {
        captureWindow(412, 892, UserPreferencesTheme.LIGHT) { _, fixture ->
            fixture.instruction = List(24) {
                "Check launch copy, website, email, and community assets."
            }.joinToString("\n")
            val release = By.text(fixture.releaseTitle)
            val result = action(release)
            assertTrue(node(By.desc("Search workflows")).visibleBounds.bottom <= result.visibleBounds.top)
            ScreenshotCapture.capture("phone-directory.png")
            result.click()
            val history = By.text("Run history")
            val tabBounds = node(history).visibleBounds
            val useBounds = action(use).visibleBounds
            assertTrue(device.swipe(40, useBounds.top - 28, 40, tabBounds.bottom + 8, 60))
            assertTrue(device.wait(Until.gone(scoped(release)), 5_000))
            assertTrue("Normal-height tabs stay pinned", node(history).visibleBounds.top < tabBounds.top)
            action(By.text("Automations")).click()
            assertTrue(action(use).isEnabled)
            node(By.text("Trigger rules"))
            ScreenshotCapture.capture("phone-automations.png")
        }

        captureWindow(1180, 820, UserPreferencesTheme.DARK) { _, fixture ->
            val directoryRow = action(By.text(fixture.releaseTitle))
            val left = directoryRow.visibleBounds
            directoryRow.click()
            action(By.text("Automations")).click()
            node(By.text("Trigger rules"))
            val right = action(use)
            assertTrue(left.right < right.visibleBounds.left)
            assertTrue(right.isEnabled)
            ScreenshotCapture.capture("wide-workflows.png")
        }
    }

    @Test
    fun captureCompactDirectoryReturn() = withDeviceSettings {
        captureWindow(360, 280, UserPreferencesTheme.LIGHT, scale = 2f) { _, fixture ->
            val release = By.text(fixture.releaseTitle)
            val compactResult = reveal(release, ::clickableAncestor)
            val compactBounds = compactResult.visibleBounds
            assertTrue(compactBounds.height() >= 48)
            ScreenshotCapture.capture("short-directory.png")
            compactResult.click()
            assertTrue(action(use).isEnabled)
            action(By.desc("Back")).click()
            node(By.desc("Search workflows"))
            val returnedResult = action(release)
            assertEquals("Returning preserves the visible directory row", compactBounds, returnedResult.visibleBounds)
        }
    }

    @Test
    fun captureCompactDetailActions() = withDeviceSettings {
        captureWindow(412, 892, UserPreferencesTheme.LIGHT) { scenario, fixture ->
            action(By.text(fixture.releaseTitle)).click()
            node(By.text("Workflow instructions"))

            resize(scenario, 360, 280, 2f)
            val edit = reveal(
                By.text("Edit instructions"),
                ::clickableAncestor,
                viewportSelector = By.clazz("android.view.View").scrollable(true),
            )
            assertTrue("Edit instructions retains a 48 dp target", edit.visibleBounds.height() >= 48)
            ScreenshotCapture.capture("short-detail-edit.png")
            edit.click()
            node(By.text("Edit"))
        }
    }

    @Test
    fun captureCompactEditorFeedback() = withDeviceSettings {
        captureWindow(412, 892, UserPreferencesTheme.LIGHT) { scenario, fixture ->
            action(By.text(fixture.releaseTitle)).click()
            action(By.text("Automations")).click()
            action(By.text("Add automation")).click()
            action(By.text("Event")).click()
            action(By.text("Google Calendar · Event created")).click()
            action(By.text("Gmail · Message received")).click()
            val draft = "Release summary"
            node(subject).text = draft
            assertEquals(draft, node(subject).text)
            closeIme(scenario)

            resize(scenario, 360, 280, 2f)
            val initialSave = reveal(save, ::disabledButton)
            val saveBounds = initialSave.visibleBounds
            assertTrue(action(viewConnections).isEnabled)
            val originalResponse = fixture.chats.commandResponse
            fixture.chats.commandResponse = { request ->
                if (request.requestUrl?.encodedPath == "/api/connectors/connected") {
                    MockResponse().setResponseCode(400)
                } else {
                    originalResponse(request)
                }
            }
            scenario.moveToState(Lifecycle.State.STARTED)
            scenario.moveToState(Lifecycle.State.RESUMED)
            val feedback = By.text("Could not refresh. Showing last loaded data.")
            node(feedback)
            val close = action(dismiss)
            assertTrue("The Snackbar close action retains a 48 dp target", close.visibleBounds.height() >= 48)
            device.waitForIdle()
            ScreenshotCapture.capture("short-editor-feedback.png")
            close.click()
            assertTrue("The user can dismiss the notice", device.wait(Until.gone(scoped(feedback)), 5_000))
            assertEquals(saveBounds, checkNotNull(disabledButton(node(save))).visibleBounds)
            assertTrue(action(viewConnections).isEnabled)
            ScreenshotCapture.capture("short-editor-actions.png")
        }
    }

    private fun captureWindow(
        width: Int,
        height: Int,
        theme: UserPreferencesTheme,
        scale: Float = 1f,
        capture: (ActivityScenario<MainActivity>, WorkflowApiFixture) -> Unit,
    ) {
        WorkflowApiFixture().use { fixture ->
            ConnectorApiFixture().use { connectors ->
                val preferences = app.initialPreferences
                val previousPreferences = app.snapshotApiPreferences()
                val auth = app.authentication as TestAuthentication
                val previousAuth = auth.state.value
                val chats = app.chatService
                val composer = app.composerService
                val workflows = app.workflows
                val previousConnectors = app.connectorService
                try {
                    device.executeShellCommand("wm size ${width}x${height}")
                    device.executeShellCommand("settings put system font_scale $scale")
                    app.chatService = fixture.service
                    app.composerService = fixture.service
                    app.workflows = fixture.service
                    app.connectorService = connectors.service
                    app.restoreApiPreferences(emptyMap())
                    app.initialPreferences =
                        testPreferences().copy(locale = UserPreferencesLocale.EN_US, theme = theme)
                    auth.state.value = testAuthenticationState(user = "user-a", session = UUID.randomUUID().toString())
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        try {
                            awaitWindow(scenario, width, height, scale)
                            node(By.desc("Workflows").enabled(true)).click()
                            capture(scenario, fixture)
                        } catch (error: Throwable) {
                            runCatching {
                                TestStorage().openOutputFile("workflow-pane-failure.xml").use(device::dumpWindowHierarchy)
                            }
                            runCatching { ScreenshotCapture.capture("workflow-pane-failure.png") }
                            throw error
                        }
                    }
                } finally {
                    app.chatService = chats
                    app.composerService = composer
                    app.workflows = workflows
                    app.connectorService = previousConnectors
                    auth.state.value = previousAuth
                    app.initialPreferences = preferences
                    app.restoreApiPreferences(previousPreferences)
                }
            }
        }
    }

    private fun withDeviceSettings(run: () -> Unit) {
        val size = displayOverride("size", "\\d+x\\d+")
        val density = displayOverride("density", "\\d+")
        val settings = listOf(
            "system font_scale",
            "secure show_ime_with_hard_keyboard",
            "secure accessibility_interactive_ui_timeout_ms",
        ).associateWith { device.executeShellCommand("settings get $it").trim() }
        val failures = mutableListOf<Throwable>()
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 0")
            device.executeShellCommand("settings put secure accessibility_interactive_ui_timeout_ms 30000")
            run()
        } catch (error: Throwable) {
            failures += error
        } finally {
            val restore = listOf("wm size ${size ?: "reset"}", "wm density ${density ?: "reset"}") +
                settings.map { (setting, value) ->
                    if (value == "null") "settings delete $setting" else "settings put $setting $value"
                }
            for (command in restore) {
                try {
                    device.executeShellCommand(command)
                } catch (error: Throwable) {
                    failures += error
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private fun resize(scenario: ActivityScenario<MainActivity>, width: Int, height: Int, scale: Float) {
        device.executeShellCommand("wm size ${width}x${height}")
        device.executeShellCommand("settings put system font_scale $scale")
        awaitWindow(scenario, width, height, scale)
    }

    private fun awaitWindow(scenario: ActivityScenario<MainActivity>, width: Int, height: Int, scale: Float) {
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

    private fun closeIme(scenario: ActivityScenario<MainActivity>) {
        fun imeVisible(): Boolean {
            var visible = false
            scenario.onActivity {
                visible = it.window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true
            }
            return visible
        }
        if (imeVisible()) {
            device.pressBack()
            val hidden = object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice) = !imeVisible()
            }
            assertTrue("The platform keyboard is closed", device.wait(hidden, 10_000))
        }
    }

    private fun reveal(
        selector: BySelector,
        target: (UiObject2) -> UiObject2?,
        viewportSelector: BySelector = By.scrollable(true),
    ): UiObject2 {
        var previousVisible: Rect? = null
        repeat(12) {
            val item = device.findObject(scoped(selector))?.let(target)
            if (item != null && item.visibleBounds.height() >= 48) return item
            previousVisible = item?.visibleBounds
            val viewport =
                device.findObjects(scoped(viewportSelector))
                    .map { it.visibleBounds }
                    .filter { it.height() >= 48 }
                    .maxByOrNull { it.height() }
                    ?: error("No scrollable pane while seeking $selector")
            val x = viewport.left + maxOf(24, viewport.width() / 10)
            val from = viewport.bottom - 12
            val to = maxOf(viewport.top + 12, from - 84)
            assertTrue(device.swipe(x, from, x, to, 60))
            device.waitForIdle()
        }
        error("Could not expose $selector. Last bounds $previousVisible")
    }

    private fun clickableAncestor(item: UiObject2) =
        generateSequence(item) { it.parent }.firstOrNull { it.isClickable }

    private fun disabledButton(item: UiObject2) =
        generateSequence(item) { it.parent }.firstOrNull {
            !it.isEnabled && it.visibleBounds.height() >= 48
        }

    private fun scoped(selector: BySelector) = By.copy(selector).pkg(app.packageName)

    private fun node(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(scoped(selector)), 10_000)) {
            "Missing workflow selector $selector"
        }

    private fun action(selector: BySelector) = checkNotNull(clickableAncestor(node(selector)))

    private fun displayOverride(setting: String, pattern: String): String? =
        Regex("Override $setting: ($pattern)").find(device.executeShellCommand("wm $setting"))?.groupValues?.get(1)
}
