package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CONNECTOR_CALENDAR_PRIMARY
import ai.okou.android.CONNECTOR_CALENDAR_SECONDARY
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
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun phoneGmailEditorRecovers() =
        onDevice("phone", 412, 892) { workflow, connector ->
            editor(workflow.releaseTitle, "收到邮件")
            editAndDismissKeyboard("标题包含", "Release summary")
            assertTrue(action("保存", enabled = false).visibleBounds.height() >= 48)
            ScreenshotCapture.capture("phone-editor-blocked.png")

            action("查看连接").click()
            text("Gmail")
            action("连接账号")
            ScreenshotCapture.capture("phone-gmail.png")
            connector.authorizeGmail()
            workflow.gmailConnected.set(true)
            back()

            action("保存")
            text("Release summary")
            assertTrue(device.findObjects(By.text("查看连接")).isEmpty())
            ScreenshotCapture.capture("phone-editor-recovered.png")
        }

    @Test
    fun wideCalendarEditorReturnsStillBlocked() =
        onDevice("wide", 1180, 820) { workflow, connector ->
            connector.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
            connector.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
            editor(workflow.releaseTitle, "创建日程")
            editAndDismissKeyboard("日历 ID", "release-calendar")
            action("查看连接").click()
            description("筛选服务类别")
            action("连接账号")
            ScreenshotCapture.capture("wide-calendar.png")
            back()

            action("查看连接")
            action("保存", enabled = false)
            text("release-calendar")
            ScreenshotCapture.capture("wide-editor-canceled.png")
        }

    private class Controls(
        val device: UiDevice,
        private val app: TestOkouApplication,
        private val activity: ActivityScenario<MainActivity>,
    ) {
        private fun find(selector: BySelector, label: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $label" }

        fun text(label: String) = find(By.pkg(app.packageName).text(label), label)

        fun description(label: String) = find(By.pkg(app.packageName).desc(label), label)

        fun action(label: String, enabled: Boolean = true): UiObject2 =
            checkNotNull(
                device.wait(
                    object : Condition<UiDevice, UiObject2?> {
                        override fun apply(device: UiDevice): UiObject2? =
                            device
                                .findObjects(By.pkg(app.packageName).text(label))
                                .firstNotNullOfOrNull { text ->
                                    try {
                                        generateSequence(text) { it.parent }
                                            .firstOrNull { it.isClickable }
                                            ?.takeIf { it.isEnabled == enabled }
                                    } catch (_: StaleObjectException) {
                                        null
                                    }
                                }
                    },
                    12_000,
                ),
            ) {
                "Missing action $label with enabled=$enabled"
            }

        fun editor(workflow: String, trigger: String) {
            description("工作流").click()
            action(workflow).click()
            action("自动化").click()
            action("添加自动化").click()
            action("定时").click()
            action(trigger).click()
            action("查看连接")
        }

        fun editAndDismissKeyboard(label: String, value: String) {
            val input = By.pkg(app.packageName).clazz("android.widget.EditText").desc(label)
            find(input, "condition field").click()
            find(input.focused(true), "focused condition field").text = value
            find(input.text(value), "preserved condition field")
            var imeVisible = false
            activity.onActivity {
                imeVisible =
                    ViewCompat.getRootWindowInsets(it.window.decorView)
                        ?.isVisible(WindowInsetsCompat.Type.ime()) == true
            }
            if (imeVisible) device.pressBack()
            action("查看连接")
        }

        fun back() {
            description("返回").click()
        }
    }

    private fun onDevice(
        scenario: String,
        width: Int,
        height: Int,
        exercise: Controls.(WorkflowApiFixture, ConnectorApiFixture) -> Unit,
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val oldConnectors = app.connectorService
        val oldChats = app.chatService
        val oldWorkflows = app.workflows
        val oldConnectivity = app.connectivity.value
        val oldPreferences = app.snapshotApiPreferences()
        val oldLocales = AppCompatDelegate.getApplicationLocales()
        val authentication = app.authentication as TestAuthentication
        val oldAuthentication = authentication.state.value
        val size = deviceOverride("size", device.executeShellCommand("wm size"))
        val density = deviceOverride("density", device.executeShellCommand("wm density"))
        val fontScale = device.executeShellCommand("settings get system font_scale").trim()
        WorkflowApiFixture(chinese = true).use { workflow ->
            ConnectorApiFixture().use { connector ->
                try {
                    device.executeShellCommand("wm size ${width}x$height")
                    device.executeShellCommand("wm density 160")
                    device.executeShellCommand("settings put system font_scale 1")
                    app.connectorService = connector.service
                    app.chatService = workflow.service
                    app.workflows = workflow.service
                    app.connectivity.value = true
                    val user = "workflow-connector-${UUID.randomUUID()}"
                    app.restoreApiPreferences(
                        oldPreferences +
                            (Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                                testPreferences()
                                    .copy(
                                        locale = UserPreferencesLocale.ZH_HANS,
                                        theme = UserPreferencesTheme.LIGHT,
                                    )),
                    )
                    authentication.state.value = testAuthenticationState(user = user)
                    ActivityScenario.launch(MainActivity::class.java).use { activity ->
                        try {
                            assertTrue(
                                device.wait(
                                    object : Condition<UiDevice, Boolean> {
                                        override fun apply(device: UiDevice): Boolean =
                                            device.displayWidth == width &&
                                                device.displayHeight == height &&
                                                app.resources.configuration.densityDpi == 160 &&
                                                app.resources.configuration.fontScale == 1f
                                    },
                                    12_000,
                                ),
                            )
                            Controls(device, app, activity).exercise(workflow, connector)
                        } catch (error: Throwable) {
                            try {
                                ScreenshotCapture.capture("failure-$scenario.png")
                                TestStorage()
                                    .openOutputFile("failure-$scenario-window.xml")
                                    .use(device::dumpWindowHierarchy)
                            } catch (diagnostic: Throwable) {
                                error.addSuppressed(diagnostic)
                            }
                            throw error
                        }
                    }
                } finally {
                    app.connectorService = oldConnectors
                    app.chatService = oldChats
                    app.workflows = oldWorkflows
                    app.connectivity.value = oldConnectivity
                    app.restoreApiPreferences(oldPreferences)
                    authentication.state.value = oldAuthentication
                    instrumentation.runOnMainSync {
                        AppCompatDelegate.setApplicationLocales(oldLocales)
                    }
                    device.executeShellCommand("wm size ${size ?: "reset"}")
                    device.executeShellCommand("wm density ${density ?: "reset"}")
                    if (fontScale == "null")
                        device.executeShellCommand("settings delete system font_scale")
                    else device.executeShellCommand("settings put system font_scale $fontScale")
                }
            }
        }
    }

    private fun deviceOverride(kind: String, output: String): String? =
        Regex("Override $kind: ([0-9x]+)").find(output)?.groupValues?.get(1)
}
