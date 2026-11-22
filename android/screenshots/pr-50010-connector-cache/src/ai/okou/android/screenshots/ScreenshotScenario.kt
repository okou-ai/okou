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
import androidx.test.uiautomator.StaleObjectException
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
    fun phoneAccountActions() =
        onDevice("phone", 412, 892, 1f) { fixture ->
            val filterIcon = description("筛选服务类别")
            assertEquals(24, filterIcon.visibleBounds.width())
            val filter = checkNotNull(touchTarget(filterIcon)).visibleBounds
            assertEquals(48, filter.width())
            assertEquals(48, filter.height())
            capture("discover-phone.png")

            text("Google Calendar").click()
            action("添加账号")
            setOnline(false)
            text("calendar@example.com").click()
            switch(true)
            action("重命名").click()
            edit("账号名称", "会议日历")
            val ready = action("保存")
            assertTrue(ready.visibleBounds.height() >= 48)
            assertFalse(device.hasObject(By.text(networkFailure)))
            capture("rename-ready-phone.png")
            fixture.rejectConnection = true
            action("保存").click()
            text(networkFailure)
            text("会议日历")
            action("保存")
            assertEquals(0, fixture.renameRequests.get())
            capture("rename-network-failure-phone.png")

            fixture.rejectConnection = false
            setOnline(true)
            fixture.deferRenameCommit = true
            action("保存").click()
            text(pending)
            action("保存", enabled = false)
            assertEquals(1, fixture.renameRequests.get())
            capture("rename-unconfirmed-phone.png")
            fixture.commitDeferredRename()
            action("重命名")
            text("会议日历")
            assertEquals(1, fixture.renameRequests.get())

            setOnline(false)
            fixture.rejectConnection = true
            action("断开账号").click()
            text("断开此账号？")
            text(networkFailure)
            capture("disconnect-impact-network-failure-phone.png")
            fixture.rejectConnection = false
            setOnline(true)
            text("2 个聊天明确选择了此账号。")
            capture("disconnect-confirmation-phone.png")
            action("取消").click()
            switch(true)
        }

    @Test
    fun phoneRetainsLoadedCategoryAndServiceWhenOffline() =
        onDevice("cache", 412, 892, 1f) { _ ->
            description("筛选服务类别").click()
            action("邮件").click()
            text("Gmail").click()
            action("连接账号")
            description("返回").click()
            text("Gmail")

            setOnline(false)
            text("离线")
            description("筛选服务类别").click()
            action("不限类别").click()
            text("推荐")
            description("筛选服务类别").click()
            action("邮件").click()
            val cachedRow = checkNotNull(touchTarget(text("Gmail")))
            assertTrue(cachedRow.visibleBounds.height() >= 80)
            assertFalse(device.hasObject(By.text("联网后加载…")))
            capture("cached-category-phone.png")

            text("Gmail").click()
            action("连接账号", enabled = false)
            assertFalse(device.hasObject(By.text("联网后加载…")))
            capture("cached-service-phone.png")
        }

    @Test
    fun phoneDeviceAuthorization() =
        onDevice("device", 412, 892, 1f) { _ ->
            description("筛选服务类别").click()
            action("开发者工具").click()
            text("Device authorization sample").click()
            action("连接账号").click()
            action("前往服务方").click()
            text(CONNECTOR_EXAMPLE_DEVICE_CODE)
            val provider = action("前往服务方")
            assertTrue(provider.visibleBounds.height() >= 48)
            capture("device-authorization-phone.png")
        }

    @Test
    fun shortWindowAuthorization() =
        onDevice("short", 820, 380, 2f) { _ ->
            description("筛选服务类别").click()
            action("开发者工具").click()
            val directory =
                find(
                    By.pkg(app.packageName)
                        .scrollable(true)
                        .hasDescendant(By.text("Device authorization sample")),
                    "filtered Connector directory",
                )
            checkNotNull(
                    directory.scrollUntil(
                        Direction.DOWN,
                        Until.findObject(By.text("Manual setup sample")),
                    )
                )
                .click()
            val detail =
                find(
                    By.pkg(app.packageName).scrollable(true).hasDescendant(By.text("账号")),
                    "Connector detail",
                )
            checkNotNull(detail.scrollUntil(Direction.DOWN, Until.findObject(By.text("连接账号"))))
            action("连接账号").click()
            val titleLabel = "连接账号 · Manual setup sample"
            val titleBounds = text(titleLabel).visibleBounds
            val cancelBounds = action("取消").visibleBounds
            val submitBounds = action("连接账号", enabled = false).visibleBounds
            val scrollBody =
                find(
                    By.pkg(app.packageName).scrollable(true).hasDescendant(By.text("Workspace")),
                    "authorization scroll body",
                )
            val body = scrollBody.visibleBounds
            val lastField = By.pkg(app.packageName).text("Notes")
            // Compose may omit scroll event positions, so the gesture helper can return
            // early even while this body still has more fields below the viewport.
            for (swipe in 1..12) {
                if (device.hasObject(lastField)) break
                assertTrue(
                    "Could not scroll the authorization body on swipe $swipe",
                    device.swipe(
                        body.centerX(),
                        body.bottom - 12,
                        body.centerX(),
                        body.top + 12,
                        24,
                    ),
                )
                device.waitForIdle()
            }
            text("Notes")
            assertEquals(titleBounds, text(titleLabel).visibleBounds)
            assertEquals(cancelBounds, action("取消").visibleBounds)
            assertEquals(submitBounds, action("连接账号", enabled = false).visibleBounds)
            assertTrue(cancelBounds.height() >= 48)
            assertTrue(submitBounds.height() >= 48)
            capture("authorization-short-large-text.png")
        }

    @Test
    fun wideAccountActions() =
        onDevice("wide", 1180, 820, 1f) { fixture ->
            text("Google Calendar").click()
            action("添加账号")
            assertTrue(text("推荐").visibleBounds.right < text("服务可申请的权限").visibleBounds.left)
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
        }

    private class Controls(
        val instrumentation: android.app.Instrumentation,
        val app: TestOkouApplication,
        val device: UiDevice,
    ) {
        val networkFailure = "暂时无法连接 Okou。请检查网络后重试。"
        val pending = "结果尚未确认。"

        fun find(selector: BySelector, description: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                "Missing visible control: $description"
            }

        fun text(label: String) = find(By.pkg(app.packageName).text(label), label)

        fun description(label: String) = find(By.pkg(app.packageName).desc(label), label)

        fun touchTarget(node: UiObject2): UiObject2? =
            generateSequence(node) { it.parent }.firstOrNull { it.isClickable }

        fun action(label: String, enabled: Boolean = true): UiObject2 =
            checkNotNull(
                device.wait(
                    object : Condition<UiDevice, UiObject2?> {
                        override fun apply(device: UiDevice): UiObject2? =
                            device
                                .findObjects(By.pkg(app.packageName).text(label))
                                .firstNotNullOfOrNull { text ->
                                    try {
                                        touchTarget(text)?.takeIf { it.isEnabled == enabled }
                                    } catch (_: StaleObjectException) {
                                        null
                                    }
                                }
                    },
                    12_000,
                )
            ) {
                "Missing action $label with enabled=$enabled"
            }

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
            val input = By.pkg(app.packageName).clazz("android.widget.EditText")
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
    }

    private fun onDevice(
        scenario: String,
        width: Int,
        height: Int,
        scale: Float,
        exercise: Controls.(ConnectorApiFixture) -> Unit,
    ) {
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
        val controls = Controls(instrumentation, app, device)
        ChatListApiFixture().use { chats ->
            ConnectorApiFixture(includeGrantExamples = true).use { fixture ->
                try {
                    device.executeShellCommand("wm size ${width}x$height")
                    device.executeShellCommand("wm density 160")
                    device.executeShellCommand("settings put system font_scale $scale")
                    app.connectorService = fixture.service
                    app.chatService = chats.service
                    app.connectivity.value = true
                    val user = "connector-cache-${UUID.randomUUID()}"
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
                            with(controls) {
                                waitForWindow(width, height, scale)
                                description("连接器").click()
                                description("筛选服务类别")
                                exercise(fixture)
                            }
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
