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
import android.view.KeyEvent
import androidx.appcompat.app.AppCompatDelegate
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
import java.util.concurrent.CountDownLatch
import kotlin.math.abs
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun compactBackReturnsToTheFilteredDirectory() =
        onDevice("connector-compact-return", 412, 892) {
            openDirectory()
            verifyDirectoryGeometry()
            action("已连接").click()
            category("会议与日程")
            search("team@example.com")
            action("Google Calendar").click()
            text("team@example.com")
            InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
            device.pressBack()

            action("Google Calendar", focused = true)
            check(searchField().text == "team@example.com")
            check(!hasText("Slack"))
            capture("phone-connector-directory-return.png")
        }

    @Test
    fun expandedWindowKeepsASelectedServiceWhileBrowsing() =
        onDevice("connector-expanded-selection", 1180, 820) { connector ->
            connector.omittedFromDefaultBrowse = setOf("gmail")
            openDirectory()
            verifyDirectoryGeometry()
            search("gmail")
            val gate = CountDownLatch(1)
            connector.detailReplyGate = gate
            try {
                activateByKeyboard("Gmail")
                textOnRight("Gmail")
                action("Gmail", focused = true)
                capture("wide-connector-keyboard-selection.png")
                search("calendar")
                action("已连接").click()
                category("会议与日程")
                action("Google Calendar")
                textOnRight("Gmail")
                check(searchField().text == "calendar")
                check(!hasText("选择连接器查看详情"))
                activity.recreate()
                action("Google Calendar")
                textOnRight("Gmail")
                check(searchField().text == "calendar")
                capture("wide-connector-selected-while-filtering.png")
            } finally {
                gate.countDown()
            }
            action("连接账号")
            action("Google Calendar").click()
            textOnRight("Google Calendar")
            action("工作日历")
            text("需要更新权限")
            action("服务可申请的权限")
            capture("wide-connector-details.png")
        }

    @Test
    fun reauthorizationReturnsToTheSameAccountWithKeyboardFocus() =
        onDevice("connector-account-reauthorization", 412, 892) { connector ->
            openDirectory()
            action("Google Calendar").click()
            action("协作日历").click()
            action("更新权限").click()
            text("更新权限 · Google Calendar")

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

            action("检查授权状态")
            connector.reauthorizeCalendar()
            activateByKeyboard("检查授权状态")
            action("默认启用", focused = true)
            text("协作日历")
            text("team@example.com")
            check(!hasText("需要更新权限"))
            capture("phone-connector-account-return.png")
        }

    private class Controls(
        val device: UiDevice,
        private val app: TestOkouApplication,
        val activity: ActivityScenario<MainActivity>,
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

        fun action(label: String, focused: Boolean = false): UiObject2 =
            checkNotNull(device.wait(object : Condition<UiDevice, UiObject2?> {
                override fun apply(device: UiDevice): UiObject2? =
                    device.findObjects(By.pkg(app.packageName).text(label)).firstNotNullOfOrNull { node ->
                        try {
                            generateSequence(node) { it.parent }.firstOrNull { it.isClickable }
                                ?.takeIf { it.isEnabled && (!focused || it.isFocused) }
                        } catch (_: StaleObjectException) {
                            null
                        }
                    }
            }, 12_000)) { "Missing enabled action $label with focus required=$focused" }

        fun textOnRight(label: String) {
            check(device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean =
                    device.findObjects(By.pkg(app.packageName).text(label)).any {
                        try {
                            it.visibleBounds.left > device.displayWidth / 3
                        } catch (_: StaleObjectException) {
                            false
                        }
                    }
            }, 12_000)) { "Missing selected detail $label" }
        }

        fun openDirectory() = description("连接器").click()

        fun searchField(): UiObject2 =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).clazz("android.widget.EditText")), 12_000),
            ) { "Missing connector search editor" }

        fun search(value: String) {
            searchField().setText(value)
            text(value)
        }

        fun category(label: String) {
            description("筛选服务类别").click()
            action(label).click()
        }

        fun verifyDirectoryGeometry() {
            val discover = generateSequence(text("发现")) { it.parent }
                .first { it.isSelected }.visibleBounds
            val connected = action("已连接").visibleBounds
            val search = searchField().visibleBounds
            val filter = generateSequence(description("筛选服务类别")) { it.parent }
                .first { it.isClickable }.visibleBounds
            val service = action("Google Calendar").visibleBounds
            check(abs(discover.width() - connected.width()) <= 1)
            check(discover.height() >= 48 && connected.height() >= 48)
            check(search.height() >= 48)
            check(filter.width() == 48 && filter.height() == 48)
            check(filter.left - search.right == 8)
            check(search.top - maxOf(discover.bottom, connected.bottom) in 8..9)
            check(service.height() >= 80)
        }

        fun activateByKeyboard(label: String) {
            repeat(8) {
                if (action(label).isFocused) {
                    device.pressKeyCode(KeyEvent.KEYCODE_ENTER)
                    return
                }
                device.pressKeyCode(KeyEvent.KEYCODE_TAB)
            }
            error("Could not reach $label with Tab")
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
                ConnectorApiFixture().use { connector ->
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
                        ActivityScenario.launch(MainActivity::class.java).use { activity ->
                            try {
                                assertTrue(device.wait(object : Condition<UiDevice, Boolean> {
                                    override fun apply(device: UiDevice): Boolean =
                                        device.displayWidth == width && device.displayHeight == height &&
                                            app.resources.configuration.densityDpi == 160 &&
                                            app.resources.configuration.fontScale == 1f
                                }, 12_000))
                                Controls(device, app, activity).exercise(connector)
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
