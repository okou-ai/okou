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
import android.content.Intent
import android.content.IntentFilter
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
    fun phoneChecksTheOriginalAttemptUntilTheProviderDeniesIt() =
        onDevice("device-unconfirmed-phone", 412, 892) { connector ->
            connector.loseFirstDevicePollReply = true
            connector.deviceExpiresIn = 10
            connector.devicePollInterval = 1
            val methodWindow = beginDeviceAuthorization()
            openControlledProvider()
            text("结果尚未确认。")
            action("检查授权状态")
            check(activeWindowId() == methodWindow)
            assertCodeHidden()
            capture("phone-device-authorization-unconfirmed.png")
            val polls = connector.devicePollRequests.get()
            connector.devicePollStatus = "denied"
            action("检查授权状态").click()
            text("服务方已拒绝授权。")
            action("前往服务方")
            check(connector.deviceStartRequests.get() == 1)
            check(connector.devicePollRequests.get() == polls + 1)
            capture("phone-device-authorization-denied.png")
        }

    @Test
    fun wideWindowConfirmsTheOriginalDeviceAccount() =
        onDevice("device-unconfirmed-wide", 1180, 820) { connector ->
            connector.loseFirstDevicePollReply = true
            connector.deviceExpiresIn = 10
            connector.devicePollInterval = 1
            beginDeviceAuthorization()
            openControlledProvider()
            text("结果尚未确认。")
            action("检查授权状态")
            assertCodeHidden()
            capture("wide-device-authorization-unconfirmed.png")
            val polls = connector.devicePollRequests.get()
            connector.devicePollStatus = "complete"
            action("检查授权状态").click()
            action("Device account")
            check(connector.deviceStartRequests.get() == 1)
            check(connector.devicePollRequests.get() == polls + 1)
            capture("wide-device-authorization-confirmed.png")
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

        fun beginDeviceAuthorization(): Int {
            description("连接器").click()
            action("设备授权示例").click()
            action("连接账号").click()
            action("设备码授权").click()
            val methodWindow = activeWindowId()
            action("前往服务方").click()
            text("ABCD-1234")
            return methodWindow
        }

        fun assertCodeHidden() {
            check(!device.hasObject(By.pkg(app.packageName).text("ABCD-1234")))
        }

        fun activeWindowId(): Int =
            checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow)
                .windowId

        fun openControlledProvider() {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val filter = IntentFilter(Intent.ACTION_VIEW).apply {
                addDataScheme("https")
                addDataAuthority("provider.example", null)
                addCategory(Intent.CATEGORY_BROWSABLE)
            }
            val monitor = instrumentation.addMonitor(filter, null, true)
            try {
                action("前往服务方").click()
                check(instrumentation.checkMonitorHit(monitor, 1))
            } finally {
                instrumentation.removeMonitor(monitor)
            }
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
                ConnectorApiFixture(includeGrantExamples = true).use { connector ->
                    try {
                        device.executeShellCommand("wm size ${width}x$height")
                        device.executeShellCommand("wm density 160")
                        device.executeShellCommand("settings put system font_scale 1")
                        app.connectorService = connector.service
                        app.chatService = composer.service
                        app.composerService = composer.service
                        app.workflows = workflow.service
                        app.connectivity.value = true
                        val user = "connector-device-outcome-${UUID.randomUUID()}"
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
