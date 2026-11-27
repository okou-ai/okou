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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
    private val subject = By.clazz("android.widget.EditText").hasDescendant(By.desc("Subject contains"))
    private val save = By.text("Save")
    private val draft = "Release summary"
    private val instructions = "Review the release owner.\n![Checklist](https://example.test/checklist.png)"

    @Test
    fun workflowEditorsKeepDraftsActionsAndFeedbackReachable() {
        val initialSize = displayOverride("size", "\\d+x\\d+")
        val initialDensity = displayOverride("density", "\\d+")
        val initialScale = device.executeShellCommand("settings get system font_scale").trim()
        val initialIme = device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        val failures = mutableListOf<Throwable>()
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
            captureWindow(412, 892, 1f, UserPreferencesTheme.LIGHT, capture = ::captureInstructions)
            captureWindow(1180, 820, 1f, UserPreferencesTheme.DARK, workflowTitle = { it.sharedTitle }) { scenario, fixture ->
                openAutomation(scenario)
                assertFooter(scenario)
                ScreenshotCapture.capture("wide-automation-editor.png")
                captureSavingAutomation(fixture)
            }
            captureWindow(412, 892, 1f, UserPreferencesTheme.LIGHT) { scenario, fixture ->
                openAutomation(scenario)
                device.executeShellCommand("wm size 360x280")
                device.executeShellCommand("settings put system font_scale 2.0")
                assertWindow(scenario, 360, 280, 2f)
                reveal(scenario, subject, minimumHeight = 96)
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
                val notice = node(By.text("Could not refresh. Showing last loaded data."))
                assertTrue("Read feedback stays visible above system insets", notice.visibleBounds.height() > 0 && notice.visibleBounds.bottom <= safeBottom(scenario))
                assertEquals(saveBounds, checkNotNull(saveControl(node(save))).visibleBounds)
                ScreenshotCapture.capture("short-editor-feedback.png")
            }
            captureWindow(412, 520, 1f, UserPreferencesTheme.LIGHT) { scenario, _ ->
                openAutomation(scenario)
                node(subject).click()
                assertIme(scenario, true)
                val editing = node(By.copy(subject).focused(true))
                assertEquals(draft, editing.text)
                assertTrue(editing.visibleBounds.bottom <= safeBottom(scenario))
                ScreenshotCapture.capture("ime-editor.png")
                assertTrue(device.pressBack())
                assertIme(scenario, false)
                assertTrue(device.hasObject(By.pkg(app.packageName).text("Edit")))
                reveal(scenario, save)
                assertFooter(scenario)
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
        workflowTitle: (WorkflowApiFixture) -> String = { it.releaseTitle },
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
                        action(By.text(workflowTitle(fixture))).click()
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

    private fun captureInstructions(scenario: ActivityScenario<MainActivity>, fixture: WorkflowApiFixture) {
        action(By.text("Edit instructions")).click()
        val field = By.clazz("android.widget.EditText").hasDescendant(By.desc("Workflow instructions"))
        reveal(scenario, field)
        node(field).text = instructions
        assertEquals(instructions, node(field).text)
        val saveAction = action(save)
        assertTrue(saveAction.isEnabled)
        val saveBounds = saveAction.visibleBounds
        ScreenshotCapture.capture("instructions-editor.png")

        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        fixture.disconnectInstructionSave = true
        fixture.beforeInstructionSave = {
            entered.countDown()
            release.await()
        }
        try {
            saveAction.click()
            assertTrue("Save reached the fixture", entered.await(10, TimeUnit.SECONDS))
            val pending = node(By.desc("Save").enabled(false))
            assertEquals(saveBounds, pending.visibleBounds)
            ScreenshotCapture.capture("saving-editor.png")
        } finally {
            release.countDown()
        }
        node(By.text("Could not save. Your changes are still here."))
        assertEquals(instructions, node(field).text)
        assertEquals(saveBounds, action(save).visibleBounds)
        ScreenshotCapture.capture("failed-save-editor.png")
    }

    private fun openAutomation(scenario: ActivityScenario<MainActivity>) {
        action(By.text("Automations")).click()
        action(By.text("Add automation")).click()
        action(By.text("Event")).click()
        action(By.text("Google Calendar · Event created")).click()
        action(By.text("Gmail · Message received")).click()
        reveal(scenario, subject)
        node(subject).text = draft
        assertEquals(draft, node(subject).text)
    }

    private fun captureSavingAutomation(fixture: WorkflowApiFixture) {
        action(By.text("Schedule")).click()
        val schedule = By.text("Schedule")
        val before = node(schedule).visibleBounds
        val saveAction = action(save)
        val saveBounds = saveAction.visibleBounds
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        fixture.beforeSharedScheduleCreate = {
            entered.countDown()
            release.await()
        }
        try {
            saveAction.click()
            assertTrue("Create reached the fixture", entered.await(10, TimeUnit.SECONDS))
            assertEquals(saveBounds, node(By.desc("Save").enabled(false)).visibleBounds)
            val mode = node(schedule)
            assertTrue(generateSequence(mode) { it.parent }.any { it.isSelected && !it.isEnabled })
            assertEquals(before, mode.visibleBounds)
            ScreenshotCapture.capture("saving-automation-editor.png")
        } finally {
            release.countDown()
        }
        node(By.text("Paused"))
    }

    private fun assertIme(scenario: ActivityScenario<MainActivity>, visible: Boolean) {
        val matches = object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean {
                var current = false
                scenario.onActivity {
                    current = it.window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true
                }
                return current == visible
            }
        }
        assertTrue("IME visible: $visible", device.wait(matches, 10_000))
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

    private fun reveal(
        scenario: ActivityScenario<MainActivity>,
        selector: BySelector,
        minimumHeight: Int = 32,
    ) {
        val scoped = By.copy(selector).pkg(app.packageName)
        repeat(16) {
            val node = device.findObject(scoped)
            val target = if (selector === save) node?.let(::saveControl) else node
            val bottom = safeBottom(scenario)
            if (target != null && target.visibleBounds.height() >= minimumHeight &&
                target.visibleBounds.bottom <= bottom
            ) return
            val scrollBounds =
                device.findObjects(By.scrollable(true).pkg(app.packageName))
                    .map { it.visibleBounds }
                    .filter { it.height() >= 48 }
                    .minByOrNull { it.height() }
                    ?: error("No scrollable editor viewport for $selector")
            val x = scrollBounds.centerX()
            val start = minOf(bottom, scrollBounds.bottom) - 12
            val drag = if (target == null) 100 else 36
            val end = maxOf(scrollBounds.top + 12, start - drag)
            assertTrue(device.swipe(x, start, x, end, 18))
            device.waitForIdle()
        }
        error("Could not scroll to $selector")
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
