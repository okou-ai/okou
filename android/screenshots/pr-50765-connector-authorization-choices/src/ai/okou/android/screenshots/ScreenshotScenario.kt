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
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
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
    fun compactDeviceAuthorizationShowsTheUserCode() =
        onDevice("connector-device-code", 412, 892) {
            openDeviceSetup()
            action("Live workspace").click()
            action("前往服务方").click()
            text("ABCD-1234")
            capture("phone-connector-device-code.png")
        }

    @Test
    fun wideDeviceConfigurationUsesTheSharedChoiceRows() =
        onDevice("connector-device-configuration", 1180, 820) {
            openDeviceSetup()
            val choice = action("Live workspace")
            check(choice.visibleBounds.height() >= 56)
            chooseWithKeyboard("Live workspace")
            action("前往服务方")
            val header = text("连接账号 · Device authorization sample")
            check(header.visibleBounds.left > device.displayWidth / 4)
            capture("wide-connector-configuration.png")
        }

    private class Controls(
        val device: UiDevice,
        private val app: TestOkouApplication,
    ) {
        fun text(label: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(By.pkg(app.packageName).text(label)), 12_000)) {
                "Missing text $label"
            }

        fun hasText(label: String) = device.hasObject(By.pkg(app.packageName).text(label))

        fun description(label: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(By.pkg(app.packageName).desc(label)), 12_000)) {
                "Missing description $label"
            }

        fun action(label: String): UiObject2 =
            checkNotNull(device.wait(object : Condition<UiDevice, UiObject2?> {
                override fun apply(device: UiDevice): UiObject2? =
                    device.findObjects(By.pkg(app.packageName).text(label)).firstNotNullOfOrNull { node ->
                        try {
                            generateSequence(node) { it.parent }.firstOrNull { it.isClickable }
                                ?.takeIf { it.isEnabled }
                        } catch (_: StaleObjectException) {
                            null
                        }
                    }
            }, 12_000)) { "Missing enabled action $label" }

        fun openDeviceSetup() {
            description("连接器").click()
            search("Device authorization")
            action("Device authorization sample").click()
            action("连接账号").click()
            text("Environment")
        }

        fun chooseWithKeyboard(label: String) {
            repeat(8) {
                if (action(label).isFocused) {
                    device.pressKeyCode(KeyEvent.KEYCODE_ENTER)
                    return
                }
                device.pressKeyCode(KeyEvent.KEYCODE_TAB)
            }
            error("Could not focus $label with Tab")
        }

        fun searchField(): UiObject2 =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).clazz("android.widget.EditText")), 12_000),
            ) { "Missing connector search editor" }

        fun search(value: String) {
            searchField().setText(value)
            text(value)
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
        val oldConnectivity = app.connectivity.value
        val authentication = app.authentication as TestAuthentication
        val oldAuthentication = authentication.state.value
        val size = overrideValue("size", device.executeShellCommand("wm size"))
        val density = overrideValue("density", device.executeShellCommand("wm density"))
        val font = device.executeShellCommand("settings get system font_scale").trim()
        ComposerApiFixture().use { composer ->
            WorkflowApiFixture(chinese = true).use { workflow ->
                ConnectorApiFixture(includeGrantExamples = true, requireDeviceEnvironment = true).use { connector ->
                    try {
                        connector.icons = connectorDesignIcons
                        device.executeShellCommand("wm size ${width}x$height")
                        device.executeShellCommand("wm density 160")
                        device.executeShellCommand("settings put system font_scale 1")
                        app.connectorService = connector.service
                        app.chatService = composer.service
                        app.composerService = composer.service
                        app.workflows = workflow.service
                        app.connectivity.value = true
                        val user = "connector-directory-return-${UUID.randomUUID()}"
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
                        instrumentation.resetInTouchMode()
                        app.connectorService = oldConnectors
                        app.chatService = oldChat
                        app.composerService = oldComposer
                        app.workflows = oldWorkflows
                        app.connectivity.value = oldConnectivity
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
