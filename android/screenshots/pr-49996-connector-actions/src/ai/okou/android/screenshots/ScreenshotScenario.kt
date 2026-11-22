package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CONNECTOR_EXAMPLE_DEVICE_CODE
import ai.okou.android.ChatListApiFixture
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
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
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun connectorActionsFollowTheActualRequestResult() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val previousConnectors = app.connectorService
        val previousChats = app.chatService
        val previousConnectivity = app.connectivity.value
        val preferences = app.snapshotApiPreferences()
        val locales = AppCompatDelegate.getApplicationLocales()
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val size = deviceOverride("size", device.executeShellCommand("wm size"))
        val density = deviceOverride("density", device.executeShellCommand("wm density"))
        val fontScale = device.executeShellCommand("settings get system font_scale").trim()
        val networkFailure = "暂时无法连接 Okou。请检查网络后重试。"
        val pending = "结果尚未确认。"

        fun find(selector: BySelector, description: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                "Missing visible control: $description"
            }

        fun text(label: String) = find(By.pkg(app.packageName).text(label), label)
        fun description(label: String) = find(By.pkg(app.packageName).desc(label), label)
        fun enabled(label: String) = find(By.pkg(app.packageName).text(label).enabled(true), label)
        fun touchTarget(node: UiObject2): UiObject2 =
            generateSequence(node) { it.parent }.first { it.isClickable }

        fun capture(name: String) {
            device.waitForIdle()
            ScreenshotCapture.capture(name)
        }
        fun setOnline(online: Boolean) {
            instrumentation.runOnMainSync { app.connectivity.value = online }
            device.waitForIdle()
        }
        fun waitForWindow(width: Int, height: Int, scale: Float) {
            assertTrue(
                "Window did not reach the requested configuration",
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            val config = app.resources.configuration
                            return device.displayWidth == width &&
                                device.displayHeight == height &&
                                config.fontScale == scale
                        }
                    },
                    12_000,
                ),
            )
        }
        fun edit(label: String, value: String) {
            val input =
                By.pkg(app.packageName)
                    .clazz("android.widget.EditText")
                    .hasDescendant(By.desc(label))
            find(input, label).click()
            find(input.focused(true), "focused $label").text = value
            find(input.text(value), "entered $label")
        }
        fun switch(checked: Boolean) =
            find(
                By.pkg(app.packageName)
                    .hasDescendant(By.text("默认启用"))
                    .checkable(true)
                    .checked(checked)
                    .enabled(true),
                "enabled default switch ($checked)",
            )

        ChatListApiFixture().use { chats ->
            ConnectorApiFixture(includeGrantExamples = true).use { fixture ->
                try {
                    device.executeShellCommand("wm size 412x892")
                    device.executeShellCommand("wm density 160")
                    device.executeShellCommand("settings put system font_scale 1.0")
                    app.connectorService = fixture.service
                    app.chatService = chats.service
                    app.connectivity.value = true
                    val user = "connector-actions-${UUID.randomUUID()}"
                    app.restoreApiPreferences(
                        preferences +
                            (Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                                testPreferences()
                                    .copy(
                                        locale = UserPreferencesLocale.ZH_HANS,
                                        theme = UserPreferencesTheme.LIGHT,
                                    ))
                    )
                    auth.state.value = testAuthenticationState(user = user)
                    ActivityScenario.launch(MainActivity::class.java).use {
                        try {
                            find(
                                    By.pkg(app.packageName).desc("连接器").enabled(true),
                                    "workspace Connectors",
                                )
                                .click()
                            text("推荐")
                            text("Google Calendar")
                            val filterIcon = description("筛选服务类别")
                            assertEquals(24, filterIcon.visibleBounds.width())
                            val filter = touchTarget(filterIcon).visibleBounds
                            assertEquals(48, filter.width())
                            assertEquals(48, filter.height())
                            capture("discover-phone.png")

                            text("Google Calendar").click()
                            enabled("添加账号")
                            setOnline(false)
                            text("calendar@example.com").click()
                            switch(true)
                            enabled("重命名").click()
                            edit("账号名称", "会议日历")
                            val ready = enabled("保存")
                            assertTrue(touchTarget(ready).visibleBounds.height() >= 48)
                            assertFalse(device.hasObject(By.text(networkFailure)))
                            capture("rename-ready-phone.png")
                            fixture.rejectConnection = true
                            enabled("保存").click()
                            text(networkFailure)
                            text("会议日历")
                            enabled("保存")
                            assertEquals(0, fixture.renameRequests.get())
                            capture("rename-network-failure-phone.png")

                            fixture.rejectConnection = false
                            fixture.loseRenameReply = true
                            enabled("保存").click()
                            text(pending)
                            find(By.pkg(app.packageName).text("保存").enabled(false), "pending Save")
                            assertEquals(1, fixture.renameRequests.get())
                            capture("rename-unconfirmed-phone.png")
                            setOnline(true)
                            enabled("重命名")
                            text("会议日历")
                            assertEquals(1, fixture.renameRequests.get())

                            setOnline(false)
                            fixture.rejectConnection = true
                            enabled("断开账号").click()
                            text("断开此账号？")
                            text(networkFailure)
                            capture("disconnect-impact-network-failure-phone.png")
                            fixture.rejectConnection = false
                            setOnline(true)
                            text("2 个聊天明确选择了此账号。")
                            capture("disconnect-confirmation-phone.png")
                            enabled("取消").click()
                            switch(true)
                            device.pressBack()
                            enabled("添加账号")
                            description("返回").click()

                            description("筛选服务类别").click()
                            enabled("开发者工具").click()
                            text("Device authorization sample").click()
                            enabled("连接账号").click()
                            enabled("前往服务方").click()
                            text(CONNECTOR_EXAMPLE_DEVICE_CODE)
                            val provider = enabled("前往服务方")
                            assertTrue(touchTarget(provider).visibleBounds.height() >= 48)
                            capture("device-authorization-phone.png")
                            enabled("取消").click()
                            enabled("连接账号")
                            description("返回").click()

                            device.executeShellCommand("wm size 820x380")
                            device.executeShellCommand("settings put system font_scale 2.0")
                            waitForWindow(820, 380, 2f)
                            text("Manual setup sample").click()
                            enabled("连接账号").click()
                            val titleLabel = "连接账号 · Manual setup sample"
                            val titleBounds = text(titleLabel).visibleBounds
                            val cancelBounds = touchTarget(enabled("取消")).visibleBounds
                            val scrollBody =
                                find(
                                    By.pkg(app.packageName)
                                        .scrollable(true)
                                        .hasDescendant(By.text("Workspace")),
                                    "authorization scroll body",
                                )
                            checkNotNull(
                                scrollBody.scrollUntil(
                                    Direction.DOWN,
                                    Until.findObject(By.text("Notes")),
                                )
                            )
                            assertEquals(titleBounds, text(titleLabel).visibleBounds)
                            assertEquals(cancelBounds, touchTarget(enabled("取消")).visibleBounds)
                            capture("authorization-short-large-text.png")
                            enabled("取消").click()
                            enabled("连接账号")
                            description("返回").click()
                            description("筛选服务类别").click()
                            enabled("不限类别").click()

                            device.executeShellCommand("settings put system font_scale 1.0")
                            device.executeShellCommand("wm size 1180x820")
                            waitForWindow(1180, 820, 1f)
                            text("Google Calendar").click()
                            enabled("添加账号")
                            assertTrue(
                                text("推荐").visibleBounds.right < text("服务可申请的权限").visibleBounds.left
                            )
                            capture("directory-detail-wide.png")
                            setOnline(false)
                            text("离线")
                            text("calendar@example.com").click()
                            val switchBounds = switch(true).visibleBounds
                            assertEquals(428, switchBounds.width())
                            assertTrue(switchBounds.height() >= 56)
                            assertFalse(device.hasObject(By.text(networkFailure)))
                            capture("account-panel-network-advisory-wide.png")
                            fixture.rejectConnection = true
                            switch(true).click()
                            text(networkFailure)
                            switch(true)
                            capture("account-panel-network-failure-wide.png")
                            fixture.rejectConnection = false
                            switch(true).click()
                            switch(false)
                        } catch (error: Throwable) {
                            try {
                                ScreenshotCapture.capture("failure.png")
                                TestStorage()
                                    .openOutputFile("failure-window.xml")
                                    .use(device::dumpWindowHierarchy)
                            } catch (diagnostic: Throwable) {
                                error.addSuppressed(diagnostic)
                            }
                            throw error
                        }
                    }
                } finally {
                    app.connectorService = previousConnectors
                    app.chatService = previousChats
                    app.connectivity.value = previousConnectivity
                    app.restoreApiPreferences(preferences)
                    auth.state.value = previousAuth
                    instrumentation.runOnMainSync {
                        AppCompatDelegate.setApplicationLocales(locales)
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
