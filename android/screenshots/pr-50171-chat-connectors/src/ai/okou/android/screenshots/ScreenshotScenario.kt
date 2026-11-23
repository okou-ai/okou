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
import android.graphics.Color
import androidx.appcompat.app.AppCompatDelegate
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
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
    fun phoneDraftReturnsFromTheExactAccount() =
        onDevice("phone", 412, 892) { _, _ ->
            action("新对话").click()
            val draft = "为发布会检查日历"
            input(draft)
            val options = generateSequence(description("聊天选项")) { it.parent }.first { it.isClickable }
            assertTrue(options.visibleBounds.height() >= 48 && options.visibleBounds.width() >= 48)
            options.click()
            assertTrue(action("连接器").visibleBounds.height() >= 56)
            capture("phone-chat-options.png")
            action("连接器").click()
            val account = action("工作日历")
            assertTrue(account.isChecked && account.visibleBounds.height() >= 72)
            awaitCalendarArtwork()
            capture("phone-connector-inherited.png")

            account.click()
            action("恢复工作区默认")
            assertTrue(!action("工作日历").isChecked)
            capture("phone-connector-override.png")

            action("协作日历").click()
            action("更新权限")
            text("team@example.com")
            capture("phone-exact-account.png")
            device.pressBack()
            assertTrue(!action("工作日历").isChecked)
            action("管理连接器").click()
            text("发现")
            text("推荐")
            awaitCalendarArtwork(inset = 42)
            capture("phone-directory.png")
            device.pressBack()
            assertTrue(!action("工作日历").isChecked)
            device.pressBack()
            action("连接器")
            device.pressBack()
            text(draft)
        }

    @Test
    fun wideExistingChatRetainsItsValueOnSaveFailure() =
        onDevice("wide", 1180, 820) { _, connector ->
            connector.rejectChatOverride = 403
            action("Personal chat").click()
            picker()
            assertTrue(action("工作日历").isChecked)
            action("工作日历").click()
            text("暂时无法保存连接器选择。")
            assertTrue(action("工作日历").isChecked)
            awaitCalendarArtwork()
            capture("wide-connector-save-failed.png")
        }

    @Test
    fun shortWindowUsesTheFullScreenPicker() =
        onDevice("short", 820, 400) { _, _ ->
            action("新对话").click()
            picker()
            description("返回")
            assertTrue(action("工作日历").isChecked)
            awaitCalendarArtwork()
            capture("short-connector-picker.png")
        }

    @Test
    fun firstReadFailureKeepsTheToolbarAndReturnPath() =
        onDevice("first-read", 412, 892) { workflow, connector ->
            connector.unavailableCatalogSlugs = setOf("gmail")
            description("工作流").click()
            action(workflow.releaseTitle).click()
            action("自动化").click()
            action("添加自动化").click()
            action("定时").click()
            action("收到邮件").click()
            action("查看连接").click()
            text("暂时无法读取连接器。")
            description("返回")
            capture("phone-connector-initial-error.png")
            device.pressBack()
            action("查看连接")
            action("保存", enabled = false)
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

        fun input(value: String) {
            fun editor() = By.pkg(app.packageName).clazz("android.widget.EditText")
            find(editor(), "composer").click()
            find(editor().focused(true), "focused composer").text = value
            find(editor().text(value), "draft $value")
        }

        fun picker() {
            description("聊天选项").click()
            action("连接器").click()
            text("用于当前对话。初始采用工作区的默认启用账号。")
        }

        fun awaitCalendarArtwork(inset: Int = 28) {
            assertTrue("Calendar brand mark has loaded", device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean {
                    val label = device.findObject(By.pkg(app.packageName).text("Google Calendar"))
                        ?: return false
                    val bounds = label.visibleBounds
                    val screenshot = takeScreenshot()
                    try {
                        val x = bounds.left - inset
                        val y = bounds.centerY() - 10
                        if (x < 0 || y < 0 || x + 20 > screenshot.width || y + 20 > screenshot.height)
                            return false
                        var colored = 0
                        for (row in y until y + 20) for (column in x until x + 20) {
                            val pixel = screenshot.getPixel(column, row)
                            val red = Color.red(pixel)
                            val green = Color.green(pixel)
                            val blue = Color.blue(pixel)
                            if (maxOf(red, green, blue) - minOf(red, green, blue) > 70) colored++
                        }
                        return colored >= 15
                    } finally {
                        screenshot.recycle()
                    }
                }
            }, 12_000))
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
        exercise: Controls.(WorkflowApiFixture, ConnectorApiFixture) -> Unit,
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
                    connector.icons = connectorDesignIcons
                    try {
                        device.executeShellCommand("wm size ${width}x$height")
                        device.executeShellCommand("wm density 160")
                        device.executeShellCommand("settings put system font_scale 1")
                        app.connectorService = connector.service
                        app.chatService = composer.service
                        app.composerService = composer.service
                        app.workflows = workflow.service
                        app.connectivity.value = true
                        val user = "chat-connectors-${UUID.randomUUID()}"
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
                                Controls(device, app).exercise(workflow, connector)
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
