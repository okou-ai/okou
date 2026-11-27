package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ComposerApiFixture
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
    fun phoneRename() = onDevice("phone-rename", 412, 892) { connector ->
        beginRename()
        capture("phone-connector-rename.png")
        action("取消").click()
        action("重命名")
        check(connector.renameRequests.get() == 0)
    }

    @Test
    fun wideAuthorization() = onDevice("wide-authorization", 1180, 820) { connector ->
        beginManualAuthorization()
        text("Access key")
        capture("wide-connector-authorization.png")
        check(connector.manualRequests.get() == 0)
    }

    @Test
    fun shortAuthorization() = onDevice("short-authorization", 820, 440) { connector ->
        beginManualAuthorization()
        capture("short-connector-authorization.png")
        action("取消").click()
        action("连接账号")
        check(connector.manualRequests.get() == 0)
    }

    @Test
    fun shortRename() = onDevice("short-rename", 820, 440) { connector ->
        beginRename()
        val cancel = action("取消")
        val before = cancel.visibleBounds
        textField().setText("团队日历")
        action("保存")
        check(action("取消").visibleBounds == before)
        capture("short-connector-rename.png")
        action("保存").click()
        action("重命名")
        text("团队日历")
        check(connector.renameRequests.get() == 1)
    }

    private class Controls(val device: UiDevice, private val app: TestOkouApplication) {
        private fun find(selector: BySelector, label: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $label" }

        fun text(label: String) = find(By.pkg(app.packageName).text(label), label)

        fun description(label: String) = find(By.pkg(app.packageName).desc(label), label)

        fun action(label: String, enabled: Boolean = true): UiObject2 =
            checkNotNull(device.wait(object : Condition<UiDevice, UiObject2?> {
                override fun apply(device: UiDevice): UiObject2? =
                    device.findObjects(By.pkg(app.packageName).text(label)).firstNotNullOfOrNull { node ->
                        try {
                            generateSequence(node) { it.parent }.firstOrNull { it.isClickable }
                                ?.takeIf { it.isEnabled == enabled }
                        } catch (_: StaleObjectException) {
                            null
                        }
                    }
            }, 12_000)) { "Missing action $label with enabled=$enabled" }

        fun textField(): UiObject2 =
            find(By.pkg(app.packageName).clazz("android.widget.EditText"), "text field")

        fun beginRename() {
            description("连接器").click()
            action("Google Calendar").click()
            action("工作日历").click()
            action("重命名").click()
            text("重命名账号")
            action("取消")
        }

        fun beginManualAuthorization() {
            description("连接器").click()
            textField().setText("Manual setup")
            action("Manual setup sample").click()
            action("连接账号").click()
            text("Workspace")
            action("取消")
        }

        fun capture(name: String) {
            device.waitForIdle()
            ScreenshotCapture.capture(name)
        }
    }

    private fun onDevice(
        scene: String,
        width: Int,
        height: Int,
        exercise: Controls.(ConnectorApiFixture) -> Unit,
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val oldConnectors = app.connectorService
        val oldChat = app.chatService
        val oldComposer = app.composerService
        val oldWorkflows = app.workflows
        val oldPreferences = app.snapshotApiPreferences()
        val oldLocales = AppCompatDelegate.getApplicationLocales()
        val authentication = app.authentication as TestAuthentication
        val oldAuthentication = authentication.state.value
        val size = overrideValue("size", device.executeShellCommand("wm size"))
        val density = overrideValue("density", device.executeShellCommand("wm density"))
        val font = device.executeShellCommand("settings get system font_scale").trim()
        ComposerApiFixture().use { composer ->
            WorkflowApiFixture(chinese = true).use { workflow ->
                ConnectorApiFixture(includeGrantExamples = true).use { connector ->
                    try {
                        device.executeShellCommand("wm size ${width}x$height")
                        device.executeShellCommand("wm density 160")
                        device.executeShellCommand("settings put system font_scale 1")
                        app.connectorService = connector.service
                        app.chatService = composer.service
                        app.composerService = composer.service
                        app.workflows = workflow.service
                        val user = "connector-form-${UUID.randomUUID()}"
                        app.restoreApiPreferences(
                            oldPreferences + (Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                                testPreferences().copy(
                                    locale = UserPreferencesLocale.ZH_HANS,
                                    theme = UserPreferencesTheme.LIGHT,
                                )),
                        )
                        authentication.state.value = testAuthenticationState(user = user)
                        ActivityScenario.launch(MainActivity::class.java).use {
                            try {
                                assertTrue(device.wait(object : Condition<UiDevice, Boolean> {
                                    override fun apply(device: UiDevice): Boolean =
                                        device.displayWidth == width && device.displayHeight == height &&
                                            app.resources.configuration.densityDpi == 160 &&
                                            app.resources.configuration.fontScale == 1f
                                }, 12_000))
                                Controls(device, app).exercise(connector)
                            } catch (error: Throwable) {
                                try {
                                    ScreenshotCapture.capture("failure-$scene.png")
                                    TestStorage().openOutputFile("failure-$scene-window.xml")
                                        .use(device::dumpWindowHierarchy)
                                } catch (diagnostic: Throwable) {
                                    error.addSuppressed(diagnostic)
                                }
                                throw error
                            }
                        }
                    } finally {
                        app.connectorService = oldConnectors
                        app.chatService = oldChat
                        app.composerService = oldComposer
                        app.workflows = oldWorkflows
                        app.restoreApiPreferences(oldPreferences)
                        authentication.state.value = oldAuthentication
                        instrumentation.runOnMainSync { AppCompatDelegate.setApplicationLocales(oldLocales) }
                        device.executeShellCommand("wm size ${size ?: "reset"}")
                        device.executeShellCommand("wm density ${density ?: "reset"}")
                        if (font == "null") device.executeShellCommand("settings delete system font_scale")
                        else device.executeShellCommand("settings put system font_scale $font")
                    }
                }
            }
        }
    }

    private fun overrideValue(kind: String, output: String): String? =
        Regex("Override $kind: ([0-9x]+)").find(output)?.groupValues?.get(1)
}
