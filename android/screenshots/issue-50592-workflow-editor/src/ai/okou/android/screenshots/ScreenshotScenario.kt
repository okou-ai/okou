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
import androidx.test.uiautomator.By
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
    @Test
    fun workflowAutomationEditor() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val previousComposer = app.composerService
        val previousWorkflows = app.workflows
        val previousConnectors = app.connectorService
        val previousConnectivity = app.connectivity.value
        val previousPreferences = app.initialPreferences
        val previousPreferenceData = app.snapshotApiPreferences()
        val originalSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val originalDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        val originalScale = device.executeShellCommand("settings get system font_scale").trim()
        val fixture = WorkflowApiFixture(chinese = true)
        val connectors = ConnectorApiFixture()
        val zone = "上海（UTC+8）"
        val calendar = "Google Calendar · 创建日程"
        val gmail = "Gmail · 收到邮件"

        fun text(label: String): UiObject2 =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).text(label)), 15_000),
            ) {
                "Missing native text: $label"
            }

        fun action(label: String): UiObject2 =
            checkNotNull(
                generateSequence(text(label)) { it.parent }.firstOrNull { it.isClickable },
            ) {
                "Missing native action: $label"
            }

        fun openDirectory() {
            text("Personal chat")
            checkNotNull(
                    device.wait(
                        Until.findObject(By.pkg(app.packageName).desc("工作流").enabled(true)),
                        10_000,
                    ),
                )
                .click()
            text(fixture.releaseTitle)
        }

        fun focusBack() {
            repeat(20) {
                device.waitForIdle()
                if (device.hasObject(By.pkg(app.packageName).desc("返回").focused(true))) return
                device.pressKeyCode(KeyEvent.KEYCODE_TAB)
            }
            error("Workflow Back did not receive keyboard focus")
        }

        fun openEditor() {
            text(fixture.releaseTitle).click()
            text("工作流说明")
            action("自动化").click()
            action("添加自动化").click()
            text(zone)
        }

        val selectedZone = By.pkg(app.packageName).text(zone).clazz("android.widget.RadioButton")

        fun showTimezonePicker(width: Int, filename: String) {
            val field = action(zone)
            assertTrue(field.visibleBounds.height() >= 56)
            field.click()
            device.waitForIdle()
            val option =
                checkNotNull(device.wait(Until.findObject(selectedZone), 10_000)) {
                    "Missing the selected region on the timezone panel"
                }
            val bounds = option.visibleBounds
            assertTrue(bounds.height() >= 56)
            assertEquals(width / 2, bounds.centerX())
            assertEquals(if (width == 412) 380 else 428, bounds.width())
            ScreenshotCapture.capture(filename)
        }

        try {
            fixture.active.set(true)
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.workflows = fixture.service
            app.connectorService = connectors.service
            app.connectivity.value = true
            app.initialPreferences =
                testPreferences()
                    .copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
            auth.state.value =
                testAuthenticationState(
                    user = "user-a",
                    session = "workflow-editor-${UUID.randomUUID()}",
                )
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 412x892")
            device.executeShellCommand("settings put system font_scale 1.0")

            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { assertEquals(412, it.resources.configuration.screenWidthDp) }
                openDirectory()
                focusBack()
                ScreenshotCapture.capture("phone-keyboard-focus.png")

                openEditor()
                text(fixture.releaseTitle)
                val schedule = text("定时").visibleBounds
                val event = action("事件").visibleBounds
                assertTrue(schedule.height() >= 48)
                assertTrue(event.height() >= 48)
                assertEquals(6, event.left - schedule.right)
                assertTrue(action("工作日").visibleBounds.height() >= 56)
                ScreenshotCapture.capture("phone-schedule.png")

                showTimezonePicker(412, "phone-timezone.png")
                device.pressBack()
                assertTrue(device.wait(Until.gone(selectedZone), 10_000))
                action("事件").click()
                text("日历 ID")
                assertTrue(action(calendar).visibleBounds.height() >= 56)
                ScreenshotCapture.capture("phone-calendar.png")

                action(calendar).click()
                action(gmail).click()
                text("保存这条规则需要连接 Gmail。")
                assertTrue(action("查看连接").isEnabled)
                ScreenshotCapture.capture("phone-gmail.png")
            }

            device.executeShellCommand("wm size 1180x820")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { assertEquals(1180, it.resources.configuration.screenWidthDp) }
                openDirectory()
                openEditor()
                showTimezonePicker(1180, "wide-timezone.png")
            }
        } finally {
            try {
                app.chatService = previousChats
                app.composerService = previousComposer
                app.workflows = previousWorkflows
                app.connectorService = previousConnectors
                app.connectivity.value = previousConnectivity
                app.initialPreferences = previousPreferences
                app.restoreApiPreferences(previousPreferenceData)
                auth.state.value = previousAuth
                connectors.use { fixture.close() }
            } finally {
                if (originalScale.toFloatOrNull() == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else {
                    device.executeShellCommand("settings put system font_scale $originalScale")
                }
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
                device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            }
        }
    }
}
