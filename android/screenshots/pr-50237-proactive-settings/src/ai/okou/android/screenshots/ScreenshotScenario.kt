package ai.okou.android.screenshots

import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ProactiveSettingsApiFixture
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun proactiveServices() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChats = app.chatService
        val originalProactive = app.proactivePreferencesService
        val originalPrefs = app.initialPreferences
        val storedPrefs = app.snapshotApiPreferences()
        val originalFont =
            device.executeShellCommand("settings get system font_scale").trim().toFloatOrNull()
        val originalSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val originalDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        fun selector() = By.pkg(app.packageName)
        fun find(by: BySelector): UiObject2 =
            checkNotNull(device.wait(Until.findObject(by), 12_000)) { "Missing control $by" }
        fun text(label: String) = find(selector().text(label))
        fun toggle(label: String, checked: Boolean): UiObject2 =
            checkNotNull(
                device.wait(
                    object : Condition<UiDevice, UiObject2?> {
                        override fun apply(device: UiDevice): UiObject2? =
                            device
                                .findObjects(selector().checkable(true).checked(checked))
                                .firstOrNull {
                                    it.text?.contains(label) == true || it.hasObject(By.text(label))
                                }
                    },
                    12_000,
                ),
            ) {
                "No $label switch with checked=$checked"
            }
        fun capture(filename: String) {
            device.waitForIdle()
            ScreenshotCapture.capture(filename)
        }
        fun showEntry(): UiObject2 {
            repeat(8) {
                device.findObject(selector().text("主动服务"))?.let {
                    return it
                }
                find(selector().scrollable(true)).scroll(Direction.DOWN, 0.65f, 600)
            }
            return text("主动服务")
        }
        fun settings() {
            find(selector().desc("设置")).click()
            text("设置")
        }
        fun returning() {
            assertTrue(device.pressBack())
            text("设置")
            // The return must restore the entry without another scroll.
            text("主动服务")
        }

        ChatListApiFixture().use { api ->
            val fixture = ProactiveSettingsApiFixture(api)
            val firstRead = CountDownLatch(1)
            fixture.beforeMorningRead = { check(firstRead.await(15, TimeUnit.SECONDS)) }
            app.chatService = api.service
            app.proactivePreferencesService = api.service.proactivePreferences
            app.initialPreferences =
                testPreferences()
                    .copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
            auth.state.value =
                testAuthenticationState(user = "proactive-light-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                ActivityScenario.launch(MainActivity::class.java).use {
                    settings()
                    val entry = showEntry()
                    assertTrue(fixture.reads.isEmpty())
                    capture("proactive-entry.png")
                    entry.click()
                    text("主动服务")
                    find(selector().desc("正在加载主动服务"))
                    capture("proactive-loading.png")
                    firstRead.countDown()
                    toggle("晨报", false)
                    toggle("建议", false)
                    capture("proactive-normal.png")

                    returning()
                    fixture.cardsEnabled = true
                    text("主动服务").click()
                    text("部分开启")
                    capture("proactive-partial.png")
                    text("部分开启").click()
                    text("目前仅接收建议卡片。")
                    capture("proactive-choices.png")
                    text("同时开启").click()
                    toggle("建议", true)
                    assertTrue(
                        device.wait(
                            object : Condition<UiDevice, Boolean> {
                                override fun apply(device: UiDevice) =
                                    fixture.cardsEnabled && fixture.suggestionsEnabled
                            },
                            12_000,
                        ),
                    )
                    capture("proactive-enabled.png")

                    fixture.morningWriteStatus = 400
                    toggle("晨报", false).click()
                    text("未能保存晨报设置，已恢复原值。")
                    toggle("晨报", false)
                    capture("proactive-rollback.png")

                    returning()
                    fixture.morningNeedsTimezone = true
                    text("主动服务").click()
                    text("请先选择时区以安排发送。")
                    check(!toggle("晨报", false).isEnabled)
                    capture("proactive-timezone.png")
                    text("时区").click()
                    text("用于新建定时任务的默认时区。")
                }

                fixture.morningNeedsTimezone = false
                fixture.morningEnabled = true
                device.executeShellCommand("settings put system font_scale 1.35")
                app.initialPreferences =
                    checkNotNull(app.initialPreferences).copy(theme = UserPreferencesTheme.DARK)
                auth.state.value =
                    testAuthenticationState(user = "proactive-dark-${UUID.randomUUID()}")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    settings()
                    showEntry().click()
                    toggle("晨报", true)
                    toggle("建议", true)
                    scenario.onActivity { check(it.resources.configuration.fontScale >= 1.3f) }
                    capture("proactive-dark-large-type.png")
                }
            } finally {
                firstRead.countDown()
                if (originalFont == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else {
                    device.executeShellCommand("settings put system font_scale $originalFont")
                }
                device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
                app.restoreApiPreferences(storedPrefs)
                app.initialPreferences = originalPrefs
                app.proactivePreferencesService = originalProactive
                app.chatService = originalChats
                auth.state.value = originalAuth
            }
        }
    }
}
