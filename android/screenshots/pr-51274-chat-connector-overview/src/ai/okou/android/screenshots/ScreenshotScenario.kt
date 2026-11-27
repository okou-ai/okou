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
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy
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
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun phoneOverviewAndAccounts() = capture("phone", 412, 892)

    @Test
    fun wideOverviewAndMemberAccess() = capture("wide", 1180, 820, memberAccess = true)

    @Test
    fun shortOverviewAndAccounts() = capture("short", 820, 440)

    private fun capture(name: String, width: Int, height: Int, memberAccess: Boolean = false) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val oldConnectors = app.connectorService
        val oldChat = app.chatService
        val oldComposer = app.composerService
        val oldPreferences = app.snapshotApiPreferences()
        val oldLocales = AppCompatDelegate.getApplicationLocales()
        val authentication = app.authentication as TestAuthentication
        val oldAuthentication = authentication.state.value
        val size = overrideValue("size", device.executeShellCommand("wm size"))
        val density = overrideValue("density", device.executeShellCommand("wm density"))
        val font = device.executeShellCommand("settings get system font_scale").trim()
        ComposerApiFixture(simulateHistory = false).use { composer ->
            ConnectorApiFixture().use { connector ->
                try {
                    composer.chats.historyReply =
                        "**先把这三件事确认好**\n\n我核对了发布排期、素材和负责人。\n\n- 确认发布日期。\n- 分享最新素材。\n- 把负责人发到群里。"
                    connector.icons = connectorDesignIcons
                    connector.seedComposerScreenshotAccounts()
                    connector.memberAccess = memberAccess
                    if (memberAccess) runBlocking {
                        connector.service.setAccountPolicy(
                            CONNECTOR_CALENDAR,
                            CONNECTOR_CALENDAR_PRIMARY,
                            ConnectorAccountPolicyRequestPolicy.ALLOW_24H,
                        )
                    }
                    device.executeShellCommand("wm size ${width}x$height")
                    device.executeShellCommand("wm density 160")
                    device.executeShellCommand("settings put system font_scale 1")
                    app.connectorService = connector.service
                    app.chatService = composer.service
                    app.composerService = composer.service
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
                            val sized = device.wait(object : Condition<UiDevice, Boolean> {
                                override fun apply(device: UiDevice): Boolean =
                                    device.displayWidth == width && device.displayHeight == height &&
                                        app.resources.configuration.densityDpi == 160
                            }, 12_000)
                            check(sized)
                            fun text(value: String): UiObject2 =
                                device.find(By.pkg(app.packageName).text(value), value)
                            fun description(value: String): UiObject2 =
                                device.find(By.pkg(app.packageName).desc(value), value)
                            text("Personal chat").click()
                            description("聊天选项").click()
                            text("连接器").click()
                            val calendar = text("Google Calendar")
                            check(connector.chatConnectorReads.toList() ==
                                listOf("/api/chat-connector-overview" to CHAT_PERSONAL))
                            device.waitForIdle()
                            ScreenshotCapture.capture("$name-chat-connector-overview.png")

                            calendar.click()
                            text("工作日历")
                            text("协作日历")
                            text("更新权限")
                            if (memberAccess) {
                                device.find(By.pkg(app.packageName).descContains("工作日历 的访问权限"), "member policy")
                            }
                            check(connector.chatConnectorReads.filter {
                                it.first.endsWith("/connections")
                            } == listOf("/api/connector-accounts/connections" to CONNECTOR_CALENDAR))
                            device.waitForIdle()
                            ScreenshotCapture.capture("$name-chat-connector-accounts.png")
                            description("返回").click()
                            text("Google Calendar")
                            check(connector.chatConnectorReads.count {
                                it.first == "/api/chat-connector-overview"
                            } == 1)
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
                    app.connectorService = oldConnectors
                    app.chatService = oldChat
                    app.composerService = oldComposer
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

    private fun UiDevice.find(selector: BySelector, label: String) =
        checkNotNull(wait(Until.findObject(selector), 12_000)) { "Missing $label" }

    private fun overrideValue(kind: String, output: String): String? =
        Regex("Override $kind: ([0-9x]+)").find(output)?.groupValues?.get(1)
}
