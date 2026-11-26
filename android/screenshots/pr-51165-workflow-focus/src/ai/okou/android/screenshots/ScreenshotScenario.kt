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
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
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
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication

    @Test
    fun workflowDirectoryRetainsKeyboardFocus() {
        val initialSize = override("size", "\\d+x\\d+")
        val initialDensity = override("density", "\\d+")
        try {
            withWorkflows(UserPreferencesTheme.LIGHT, wide = false) { fixture ->
                openDirectoryWithKeyboardFocus(fixture)
                val originalBounds = node(By.text(fixture.releaseTitle)).visibleBounds
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
                node(By.text("工作流说明"))
                assertTrue(device.pressBack())
                waitForRowFocus(fixture.releaseTitle)
                assertEquals(originalBounds, node(By.text(fixture.releaseTitle)).visibleBounds)
                node(By.text("仅自己"))
                ScreenshotCapture.capture("workflow-phone-return-focus.png")
            }
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 1180x820")
            withWorkflows(UserPreferencesTheme.DARK, wide = true) { fixture ->
                openDirectoryWithKeyboardFocus(fixture)
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
                node(By.text("工作流说明"))
                waitForRowFocus(fixture.releaseTitle)
                ScreenshotCapture.capture("workflow-wide-directory-focus.png")
            }
        } catch (failure: Throwable) {
            runCatching {
                TestStorage().openOutputFile("workflow-focus-failure.xml")
                    .use(device::dumpWindowHierarchy)
                ScreenshotCapture.capture("workflow-focus-failure.png")
            }
            throw failure
        } finally {
            try {
                device.executeShellCommand("wm size ${initialSize ?: "reset"}")
            } finally {
                try {
                    device.executeShellCommand("wm density ${initialDensity ?: "reset"}")
                } finally {
                    instrumentation.resetInTouchMode()
                }
            }
        }
    }

    private fun openDirectoryWithKeyboardFocus(fixture: WorkflowApiFixture) {
        node(By.text("Personal chat"))
        node(By.desc("工作流").enabled(true)).click()
        node(By.text("仅自己")).click()
        node(By.text(fixture.releaseTitle))
        instrumentation.setInTouchMode(false)
        repeat(16) {
            if (rowHasFocus(fixture.releaseTitle)) return
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
            instrumentation.waitForIdleSync()
        }
        waitForRowFocus(fixture.releaseTitle)
    }

    private fun rowHasFocus(title: String): Boolean =
        generateSequence(device.findObject(By.text(title).pkg(app.packageName))) { it.parent }
            .takeWhile { it.applicationPackage == app.packageName }
            .any { it.isClickable && it.isFocused }

    private fun waitForRowFocus(title: String) {
        val focused = device.wait(
            Until.hasObject(By.focused(true).pkg(app.packageName).hasDescendant(By.text(title))),
            3_000,
        )
        assertTrue("$title must retain keyboard focus", focused || rowHasFocus(title))
    }

    private fun node(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector.pkg(app.packageName)), 15_000)) {
            "Missing workflow selector $selector"
        }

    private fun override(setting: String, value: String): String? =
        Regex("Override $setting: ($value)")
            .find(device.executeShellCommand("wm $setting"))
            ?.groupValues
            ?.get(1)

    private fun withWorkflows(
        theme: UserPreferencesTheme,
        wide: Boolean,
        capture: (WorkflowApiFixture) -> Unit,
    ) {
        WorkflowApiFixture(chinese = true).use { fixture ->
            ConnectorApiFixture().use { connectors ->
                val preferences = app.initialPreferences
                val preferenceData = app.snapshotApiPreferences()
                val auth = app.authentication as TestAuthentication
                val authState = auth.state.value
                val chats = app.chatService
                val composer = app.composerService
                val workflows = app.workflows
                val connectorService = app.connectorService
                try {
                    app.chatService = fixture.service
                    app.composerService = fixture.service
                    app.workflows = fixture.service
                    app.connectorService = connectors.service
                    app.restoreApiPreferences(emptyMap())
                    app.initialPreferences = testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = theme,
                        timezone = "Asia/Shanghai",
                    )
                    auth.state.value = testAuthenticationState(
                        user = "user-a",
                        session = "workflow-focus-${UUID.randomUUID()}",
                    )
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        scenario.onActivity { activity ->
                            val configuration = activity.resources.configuration
                            assertEquals(wide, configuration.screenWidthDp >= 840)
                            assertEquals(1f, configuration.fontScale, .001f)
                        }
                        capture(fixture)
                    }
                } finally {
                    app.chatService = chats
                    app.composerService = composer
                    app.workflows = workflows
                    app.connectorService = connectorService
                    auth.state.value = authState
                    app.initialPreferences = preferences
                    app.restoreApiPreferences(preferenceData)
                }
            }
        }
    }
}
