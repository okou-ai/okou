package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.CONNECTOR_CALENDAR_PRIMARY
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
import androidx.appcompat.app.AppCompatDelegate
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun phoneReadFeedback() = capture("phone", 412, 892)

    @Test
    fun wideReadFeedback() =
        capture("wide", 1180, 820)

    @Test
    fun shortReadFeedback() =
        capture("short", 820, 440)

    private fun capture(name: String, width: Int, height: Int) {
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
                    connector.rejectChatOverride = 503
                    device.executeShellCommand("wm size ${width}x$height")
                    device.executeShellCommand("wm density 160")
                    device.executeShellCommand("settings put system font_scale 1")
                    app.connectorService = connector.service
                    app.chatService = composer.service
                    app.composerService = composer.service
                    val user = "chat-connector-confirmation-${UUID.randomUUID()}"
                    val preferences =
                        testPreferences().copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = UserPreferencesTheme.LIGHT,
                        )
                    app.restoreApiPreferences(
                        previousPreferences + (Triple(BuildConfig.API_ORIGIN, user, "org-a") to preferences),
                    )
                    authentication.state.value = testAuthenticationState(user = user)

                    ActivityScenario.launch(MainActivity::class.java).use {
                        try {
                            check(
                                device.wait(
                                    object : Condition<UiDevice, Boolean> {
                                        override fun apply(device: UiDevice): Boolean =
                                            device.displayWidth == width &&
                                                device.displayHeight == height &&
                                                app.resources.configuration.densityDpi == 160
                                    },
                                    12_000,
                                ) == true,
                            )
                            fun text(label: String): UiObject2 =
                                device.find(By.pkg(app.packageName).text(label), label)
                            fun activeWindowId() = instrumentation.uiAutomation.windows.first { it.isActive }.id

                            connector.failChatOverview = true
                            text("Personal chat").click()
                            device.find(By.pkg(app.packageName).desc("聊天选项"), "Chat options").click()
                            text("连接器").click()
                            text("暂时无法加载")
                            text("管理连接器")
                            val overview = "/api/chat-connector-overview" to CHAT_PERSONAL
                            check(connector.chatConnectorReads.count { it == overview } == 3)
                            device.waitForIdle()
                            ScreenshotCapture.capture("$name-cold-overview.png")

                            connector.failChatOverview = false
                            device.executeShellCommand("input keyevent KEYCODE_BACK")
                            text("连接器").click()
                            val calendar = text("Google Calendar")
                            val sheet = activeWindowId()
                            connector.failAccountReads = true
                            connector.accountRetryAfterSeconds = 0
                            calendar.click()
                            text("暂时无法加载")
                            check(activeWindowId() == sheet)
                            device.waitForIdle()
                            ScreenshotCapture.capture("$name-cold-accounts.png")

                            connector.failAccountReads = false
                            device.executeShellCommand("input keyevent KEYCODE_BACK")
                            text("管理连接器")
                            text("Google Calendar").click()
                            text("工作日历").click()
                            text("结果尚未确认。")
                            device.executeShellCommand("input keyevent KEYCODE_BACK")
                            text("管理连接器")
                            connector.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
                            connector.addCalendarAccount("10000000-0000-4000-8000-000000000008")
                            connector.failChatOverview = true
                            text("核对结果").click()
                            text("暂时无法刷新连接器。")
                            text("Google Calendar")
                            text("管理连接器")
                            check(activeWindowId() == sheet)
                            check(connector.chatConnectorReads.count { it == overview } == 7)
                            check(connector.chatOverrideReads.toList() == List(2) { CHAT_PERSONAL to CONNECTOR_CALENDAR })
                            check(connector.chatOverrideRequests.size == 1)
                            device.waitForIdle()
                            ScreenshotCapture.capture("$name-refresh.png")

                            connector.failChatOverview = false
                            device.executeShellCommand("input keyevent KEYCODE_BACK")
                            text("连接器").click()
                            text("Google Calendar").click()
                            text("replacement@example.com")
                            check(!device.hasObject(By.pkg(app.packageName).text("暂时无法刷新连接器。")))
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
                    if (previousFontScale == "null")
                        device.executeShellCommand("settings delete system font_scale")
                    else device.executeShellCommand("settings put system font_scale $previousFontScale")
                }
            }
        }
    }

    private fun UiDevice.find(selector: BySelector, label: String) =
        checkNotNull(wait(Until.findObject(selector), 12_000)) { "Missing $label" }

    private fun overrideValue(kind: String, output: String): String? =
        Regex("Override $kind: ([0-9x]+)").find(output)?.groupValues?.get(1)
}
