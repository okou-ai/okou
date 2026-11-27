package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ComposerApiFixture
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Rect
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
import java.util.concurrent.CountDownLatch
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun compactDirectoryShowsLoadingAndNativeRows() =
        onDevice("phone-directory", 412, 892) { fixture ->
            val discovery = CountDownLatch(1)
            fixture.discoveryGate = discovery
            try {
                description("连接器").click()
                description("正在读取连接器…")
                capture("phone-connectors-loading.png")
            } finally {
                discovery.countDown()
            }
            text("推荐")
            text("需要重新授权")
            action("Google Calendar").click()
            text("需要更新权限")
            back()
            text("1 个账号可用 · 有账号需要处理")
            val row = action("Google Calendar").visibleBounds
            check(row.left == 16 && row.right == 396 && row.height() >= 88) { "Discover row: $row" }
            waitForMarks(directoryMarks("Google Calendar", "Gmail", "Slack"))
            capture("phone-connectors-discover.png")
            action("已连接").click()
            gone("推荐")
            val connected = action("Google Calendar").visibleBounds
            check(connected.height() == 72) { "Connected row: $connected" }
            waitForMarks(directoryMarks("Google Calendar", "Slack"))
            capture("phone-connectors-connected.png")
        }

    @Test
    fun wideDirectoryShowsAccountAndPermissionActions() =
        onDevice("wide-directory", 1180, 820) { fixture ->
            description("连接器").click()
            action("Google Calendar").click()
            text("工作日历")
            text("需要更新权限")
            val permission = action("服务可申请的权限").visibleBounds
            check(permission.height() == 56) { "Permissions row: $permission" }
            val add = action("添加账号")
            check(add.visibleBounds.height() >= 40) { "Outlined button: ${add.visibleBounds}" }
            waitForMarks(directoryMarks("Google Calendar", "Gmail", "Slack"))
            capture("wide-connectors-details.png")
            add.click()
            text("添加账号 · Google Calendar")
            action("前往服务方")
            action("取消")
            capture("wide-connectors-authorization.png")

            action("取消").click()
            action("工作日历").click()
            action("重命名").click()
            text("重命名账号")
            val draft = "会议日历"
            fixture.deferRenameCommit = true
            editor().setText(draft)
            action("保存").click()
            text("未能保存，修改已保留。")
            text(draft)
            action("保存")
            check(fixture.renameRequests.get() == 1)
            capture("wide-connector-rename-failed.png")
        }

    @Test
    fun compactPickerRefreshesWarmRowsAndRetainsThemOnFailure() =
        onDevice("phone-picker", 412, 892) { fixture ->
            fixture.authorizeGmail()
            openChatPicker()
            val calendar = action("Google Calendar")
            text("2 个账号")
            val calendarBounds = calendar.visibleBounds
            check(calendarBounds.height() == 56) { "Service row: $calendarBounds" }
            val slack = text("Slack").visibleBounds
            val footer = action("管理连接器").visibleBounds
            waitForMarks(listOf("Google Calendar", "Gmail", "Slack").map { name ->
                markRegion(action(name).visibleBounds, width = 24)
            })
            capture("phone-chat-connectors.png")
            back()
            text("聊天选项")
            back()
            description("聊天选项")

            fixture.failChatOverview = true
            openChatPicker(fromChatList = false)
            action("Google Calendar")
            val failure = text("暂时无法刷新连接器。")
            check(text("Slack").visibleBounds.bottom <= failure.visibleBounds.top)
            check(text("Slack").visibleBounds == slack)
            check(action("Google Calendar").visibleBounds == calendarBounds)
            check(action("管理连接器").visibleBounds == footer)
            check(fixture.chatConnectorReads.count { it == overviewRead } == 4)
            capture("phone-chat-connectors-refresh-failed.png")

            action("Google Calendar").click()
            text("工作日历")
            back()
            action("Google Calendar")
            check(fixture.chatConnectorReads.count { it == overviewRead } == 4)
        }

    @Test
    fun widePickerEndsFailedSaveAndRestoresSend() =
        onDevice("wide-picker", 1180, 820) { fixture ->
            text("Personal chat").click()
            val draft = "查看本周的日程"
            editor().setText(draft)
            text(draft)
            description("发送", enabled = true)
            openChatPicker(fromChatList = false)
            action("Google Calendar").click()
            val account = action("工作日历")
            check(account.isChecked) { "Expected the confirmed default" }
            val reply = CountDownLatch(1)
            fixture.rejectChatOverride = 503
            fixture.chatOverrideReplyGate = reply
            try {
                account.click()
                text("正在保存连接器选择…")
                condition("pending save") { fixture.chatOverrideRequests.size == 1 }
                check(!action("工作日历", enabled = false).isChecked)
                capture("wide-chat-connectors-saving.png")
            } finally {
                reply.countDown()
            }
            text("暂时无法保存连接器选择。")
            check(action("工作日历").isChecked)
            check(fixture.chatOverrideReads.isEmpty())
            check(fixture.chatOverrideRequests.size == 1)
            capture("wide-chat-connectors-restored.png")
            back()
            action("Google Calendar")
            check(fixture.chatConnectorReads.count { it == overviewRead } == 1)
            back()
            text("聊天选项")
            back()
            description("发送", enabled = true)
            text(draft)
        }

    private val overviewRead = "/api/chat-connector-overview" to CHAT_PERSONAL

    private class Controls(val device: UiDevice, private val packageName: String) {
        fun text(label: String): UiObject2 =
            find(By.pkg(packageName).text(label), label)

        fun description(label: String, enabled: Boolean? = null): UiObject2 {
            val selector = By.pkg(packageName).desc(label)
            if (enabled != null) selector.enabled(enabled)
            return find(selector, label)
        }

        fun action(label: String, enabled: Boolean = true): UiObject2 =
            checkNotNull(
                device.wait(
                    object : Condition<UiDevice, UiObject2?> {
                        override fun apply(device: UiDevice): UiObject2? =
                            device.findObjects(By.pkg(packageName).text(label)).firstNotNullOfOrNull { node ->
                                try {
                                    generateSequence(node) { it.parent }.firstOrNull { it.isClickable }
                                        ?.takeIf { it.isEnabled == enabled }
                                } catch (_: StaleObjectException) {
                                    null
                                }
                            }
                    },
                    12_000,
                ),
            ) { "Missing action $label (enabled=$enabled)" }

        fun condition(label: String, predicate: () -> Boolean) {
            check(
                device.wait(object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice) = predicate()
                }, 12_000) == true,
            ) { "Timed out waiting for $label" }
        }

        fun gone(label: String) {
            check(device.wait(Until.gone(By.pkg(packageName).text(label)), 12_000) == true) {
                "$label is still visible"
            }
        }

        fun openChatPicker(fromChatList: Boolean = true) {
            if (fromChatList) text("Personal chat").click()
            description("聊天选项").click()
            text("聊天选项")
            action("连接器").click()
            action("管理连接器")
        }

        fun back() {
            device.executeShellCommand("input keyevent KEYCODE_BACK")
        }

        fun editor() =
            find(By.pkg(packageName).clazz("android.widget.EditText").enabled(true), "editable draft")

        fun directoryMarks(vararg names: String) =
            names.map { name -> markRegion(action(name).visibleBounds, width = 40) }

        fun markRegion(row: Rect, width: Int) =
            Rect(row.left + 16, row.top, row.left + 16 + width, row.bottom)

        fun waitForMarks(regions: List<Rect>) {
            val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
            condition("connector brand marks painted") {
                val bitmap = automation.takeScreenshot() ?: return@condition false
                try {
                    regions.all { region ->
                        (region.top until region.bottom).any { y ->
                            (region.left until region.right).any { x ->
                                val pixel = bitmap.getPixel(x, y)
                                val red = android.graphics.Color.red(pixel)
                                val green = android.graphics.Color.green(pixel)
                                val blue = android.graphics.Color.blue(pixel)
                                maxOf(red, green, blue) - minOf(red, green, blue) > 72
                            }
                        }
                    }
                } finally {
                    bitmap.recycle()
                }
            }
        }

        fun capture(name: String) {
            device.waitForIdle()
            ScreenshotCapture.capture(name)
        }

        private fun find(selector: BySelector, label: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $label" }
    }

    private fun onDevice(
        name: String,
        width: Int,
        height: Int,
        exercise: Controls.(ConnectorApiFixture) -> Unit,
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val previousConnectors = app.connectorService
        val previousChat = app.chatService
        val previousComposer = app.composerService
        val previousPreferences = app.snapshotApiPreferences()
        val previousLocales = AppCompatDelegate.getApplicationLocales()
        val authentication = app.authentication as TestAuthentication
        val previousAuthentication = authentication.state.value
        val previousSize = overrideValue("size", device.executeShellCommand("wm size"))
        val previousDensity = overrideValue("density", device.executeShellCommand("wm density"))
        val previousFontScale = device.executeShellCommand("settings get system font_scale").trim()

        ComposerApiFixture(simulateHistory = false).use { composer ->
            ConnectorApiFixture().use { connector ->
                try {
                    connector.icons = connectorDesignIcons
                    device.executeShellCommand("wm size ${width}x$height")
                    device.executeShellCommand("wm density 160")
                    device.executeShellCommand("settings put system font_scale 1")
                    app.connectorService = connector.service
                    app.chatService = composer.service
                    app.composerService = composer.service
                    val user = "connector-v425-${UUID.randomUUID()}"
                    val preferences = testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                    )
                    app.restoreApiPreferences(
                        previousPreferences + (Triple(BuildConfig.API_ORIGIN, user, "org-a") to preferences),
                    )
                    authentication.state.value = testAuthenticationState(user = user)
                    ActivityScenario.launch(MainActivity::class.java).use {
                        val controls = Controls(device, app.packageName)
                        try {
                            controls.condition("requested display and text size") {
                                device.displayWidth == width && device.displayHeight == height &&
                                    app.resources.configuration.densityDpi == 160 &&
                                    app.resources.configuration.fontScale == 1f
                            }
                            controls.exercise(connector)
                        } catch (error: Throwable) {
                            try {
                                ScreenshotCapture.capture("failure-$name.png")
                                TestStorage().openOutputFile("failure-$name-window.xml")
                                    .use(device::dumpWindowHierarchy)
                            } catch (diagnostic: Throwable) {
                                error.addSuppressed(diagnostic)
                            }
                            throw error
                        }
                    }
                } finally {
                    instrumentation.resetInTouchMode()
                    app.connectorService = previousConnectors
                    app.chatService = previousChat
                    app.composerService = previousComposer
                    app.restoreApiPreferences(previousPreferences)
                    authentication.state.value = previousAuthentication
                    instrumentation.runOnMainSync {
                        AppCompatDelegate.setApplicationLocales(previousLocales)
                    }
                    device.executeShellCommand("wm size ${previousSize ?: "reset"}")
                    device.executeShellCommand("wm density ${previousDensity ?: "reset"}")
                    if (previousFontScale == "null") {
                        device.executeShellCommand("settings delete system font_scale")
                    } else {
                        device.executeShellCommand("settings put system font_scale $previousFontScale")
                    }
                }
            }
        }
    }

    private fun overrideValue(kind: String, output: String): String? =
        Regex("Override $kind: ([0-9x]+)").find(output)?.groupValues?.get(1)
}
