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
import kotlin.time.Clock
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    fun phonePolicyMenuKeepsTheConfirmedValueDuringSave() =
        onDevice("phone-policy", 412, 892) { fixture ->
            openExistingChat()
            openPicker()
            action("Google Calendar").click()
            text("访问策略适用于你在此工作区的所有对话。")
            text("更新权限")
            val before = assertPickerBounds(policy("允许 始终").visibleBounds)
            policy("允许 始终").click()
            action("允许 1 小时")
            action("允许 7 天")
            val menuRow = action("拒绝").visibleBounds
            check(menuRow.width() == 244 && menuRow.height() >= 48) { "Policy menu row $menuRow" }
            capture("phone-member-policy-menu.png")

            val reply = CountDownLatch(1)
            fixture.policyWriteReplyGate = reply
            try {
                action("允许 24 小时").click()
                text("正在保存连接器选择…")
                condition("policy write reached the service") {
                    fixture.policyWriteReplyStarted.count == 0L
                }
                text("允许 始终")
            } finally {
                reply.countDown()
            }
            remaining()
            val saved = assertPickerBounds(policy("允许 ").visibleBounds)
            check(saved.left == before.left && saved.right == before.right)
            check(fixture.chatConnectorReads.count { it == policyRead } == 1)
            text("更新权限")
            capture("phone-member-policy-confirmed.png")
        }

    fun wideWindowReusesTheMemberPolicyInAnotherComposer() =
        onDevice("wide-policy", 1180, 820) { fixture ->
            runBlocking {
                fixture.service.setAccountPolicy(
                    CONNECTOR_CALENDAR,
                    CONNECTOR_CALENDAR_PRIMARY,
                    ConnectorAccountPolicyRequestPolicy.ALLOW_24H,
                )
            }
            openExistingChat()
            openPicker()
            action("Google Calendar").click()
            remaining()
            assertPickerBounds(policy("允许 ").visibleBounds)
            closePicker()
            actionOrDescription("新聊天").click()
            openPicker()
            action("Google Calendar").click()
            remaining()
            val field = assertPickerBounds(policy("允许 ").visibleBounds)
            val repair = action("更新权限").visibleBounds
            check(field.left > 600 && field.right < 820 && repair.bottom > field.bottom) {
                "Expected centered wide panel with a separately reachable repair action"
            }
            check(
                fixture.chatConnectorReads.filter { it.first == "/api/chat-connector-overview" }
                    .map { it.second } == listOf(CHAT_PERSONAL, null),
            )
            check(fixture.chatConnectorReads.count { it == accountRead } == 2)
            check(fixture.chatConnectorReads.count { it == policyRead } == 1)
            capture("wide-member-policy-reused.png")
        }

    @Test
    fun shortWindowShowsAnExpiredPolicyAtLargeText() =
        onDevice("short-policy", 540, 460, fontScale = 2f) { fixture ->
            fixture.setPolicyForScreenshot(CONNECTOR_CALENDAR_PRIMARY, Clock.System.now() - 1.seconds)
            actionOrDescription("新聊天").click()
            openPicker(scroll = true)
            actionAfterScroll("Google Calendar").click()
            val expired = textAfterScroll("已到期", minimumHeight = 21)
            check(expired.visibleBounds.height() > 20) { "Expired caption should follow font scaling" }
            val field = policy("拒绝 已到期").visibleBounds
            check(field.height() >= 56) { "The expired selection field must be visible: $field" }
            capture("short-member-policy-expired.png")
            val repair = textAfterScroll("更新权限")
            check(repair.isEnabled)
            check(fixture.chatConnectorReads.count { it == policyRead } == 1)
        }

    private fun assertPickerBounds(bounds: Rect): Rect {
        check(bounds.width() == 144 && bounds.height() == 56) { "Policy field bounds $bounds" }
        return bounds
    }

    private class Controls(val device: UiDevice, private val packageName: String) {
        fun text(label: String): UiObject2 = find(By.pkg(packageName).text(label), label)

        fun policy(value: String, enabled: Boolean = true): UiObject2 =
            find(
                By.pkg(packageName).descStartsWith("工作日历 的访问权限, $value").enabled(enabled),
                "policy $value",
            )

        fun remaining(): UiObject2 =
            find(By.pkg(packageName).textStartsWith("剩余 "), "remaining duration")

        fun action(label: String): UiObject2 =
            checkNotNull(
                device.wait(
                    object : Condition<UiDevice, UiObject2?> {
                        override fun apply(device: UiDevice): UiObject2? =
                            actionFor(device, label)
                    },
                    12_000,
                ),
            ) { "Missing action $label" }

        fun actionOrDescription(label: String): UiObject2 =
            checkNotNull(
                device.wait(
                    object : Condition<UiDevice, UiObject2?> {
                        override fun apply(device: UiDevice): UiObject2? =
                            actionFor(device, label)
                                ?: device.findObject(By.pkg(packageName).desc(label).clickable(true))
                    },
                    12_000,
                ),
            ) { "Missing action or description $label" }

        private fun actionFor(device: UiDevice, label: String): UiObject2? =
            device.findObjects(By.pkg(packageName).text(label)).firstNotNullOfOrNull { node ->
                try {
                    generateSequence(node) { it.parent }.firstOrNull { it.isClickable }
                        ?.takeIf { it.isEnabled }
                } catch (_: StaleObjectException) {
                    null
                }
            }

        fun actionAfterScroll(label: String): UiObject2 {
            repeat(5) {
                val match = device.wait(
                    object : Condition<UiDevice, UiObject2?> {
                        override fun apply(device: UiDevice): UiObject2? = actionFor(device, label)
                    },
                    1_000,
                )
                if (match != null) return match
                scrollDown()
            }
            return action(label)
        }

        fun textAfterScroll(label: String, minimumHeight: Int = 1): UiObject2 {
            val selector = By.pkg(packageName).text(label)
            repeat(5) {
                val node = device.wait(Until.findObject(selector), 1_000)
                if (node != null && node.visibleBounds.height() >= minimumHeight) return node
                scrollDown()
            }
            return find(selector, label)
        }

        private fun scrollDown() {
            val scrollable = device.findObject(By.pkg(packageName).scrollable(true)) ?: return
            val bounds = scrollable.visibleBounds
            if (bounds.height() > 36) {
                val x = bounds.centerX()
                device.swipe(x, bounds.bottom - 16, x, bounds.top + 16, 18)
            }
        }

        fun condition(label: String, predicate: () -> Boolean) {
            check(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) = predicate()
                    },
                    12_000,
                ) == true,
            ) { "Timed out waiting for $label" }
        }

        fun openExistingChat() {
            action("Personal chat").click()
        }

        fun openPicker(scroll: Boolean = false) {
            find(By.pkg(packageName).desc("聊天选项"), "chat options").click()
            if (scroll) actionAfterScroll("连接器").click()
            else {
                action("连接器").click()
                action("Google Calendar")
            }
        }

        fun closePicker() {
            back()
            action("管理连接器")
            back()
            action("连接器")
            back()
            check(device.wait(Until.gone(By.pkg(packageName).text("聊天选项")), 12_000) == true)
        }

        fun capture(name: String) {
            device.waitForIdle()
            ScreenshotCapture.capture(name)
        }

        private fun back() {
            device.executeShellCommand("input keyevent KEYCODE_BACK")
        }

        private fun find(selector: BySelector, label: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $label" }
    }

    private fun onDevice(
        name: String,
        width: Int,
        height: Int,
        fontScale: Float = 1f,
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
                    connector.memberAccess = true
                    device.executeShellCommand("wm size ${width}x$height")
                    device.executeShellCommand("wm density 160")
                    device.executeShellCommand("settings put system font_scale $fontScale")
                    app.connectorService = connector.service
                    app.chatService = composer.service
                    app.composerService = composer.service
                    val user = "connector-policy-${UUID.randomUUID()}"
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
                        val controls = Controls(device, app.packageName)
                        try {
                            controls.condition("requested environment") {
                                device.displayWidth == width && device.displayHeight == height &&
                                    app.resources.configuration.densityDpi == 160 &&
                                    app.resources.configuration.fontScale == fontScale
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

    companion object {
        private val accountRead = "/api/connector-accounts/connections" to CONNECTOR_CALENDAR
        private val policyRead = "/api/connector-account-access/policies" to CONNECTOR_CALENDAR
    }
}
