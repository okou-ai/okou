package ai.okou.android.screenshots

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ProactiveSettingsApiFixture
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.view.KeyEvent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.StaleObjectException
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
        val originalRecovery = app.recoveryService
        val originalProactive = app.proactivePreferencesService
        val originalPrefs = app.initialPreferences
        val originalPreferenceWrite = app.preferenceWrite
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
        fun contains(label: String) = find(selector().textContains(label))
        fun rowFocused(label: String): Boolean =
            device.findObjects(selector().focused(true)).any {
                try {
                    it.text?.contains(label) == true || it.hasObject(By.textContains(label))
                } catch (_: StaleObjectException) {
                    false
                }
            }
        fun awaitFocus(label: String) {
            check(device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice) = rowFocused(label)
            }, 12_000)) { "Keyboard focus did not reach $label" }
        }
        fun tabTo(label: String) {
            repeat(12) {
                if (rowFocused(label)) return
                check(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
                device.waitForIdle()
            }
            check(rowFocused(label)) { "Tab traversal did not find $label" }
        }
        fun toggle(label: String, checked: Boolean): UiObject2 =
            checkNotNull(
                device.wait(
                    object : Condition<UiDevice, UiObject2?> {
                        override fun apply(device: UiDevice): UiObject2? =
                            device
                                .findObjects(selector().checkable(true).checked(checked))
                                .firstOrNull {
                                    // A new layout can replace a switch while the app changes theme.
                                    try {
                                        it.text?.contains(label) == true || it.hasObject(By.text(label))
                                    } catch (_: StaleObjectException) {
                                        false
                                    }
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
        fun openRegionTimezone() {
            settings()
            repeat(10) {
                device.findObject(selector().text("时区"))?.let {
                    it.click()
                    return
                }
                find(selector().scrollable(true)).scroll(Direction.DOWN, 0.55f, 500)
            }
            text("时区").click()
        }
        fun returning() {
            find(selector().desc("返回")).click()
            text("设置")
            // The return must restore the entry without another scroll.
            text("主动服务")
        }

        ChatListApiFixture().use { api ->
            val models = DefaultModelApiFixture(api)
            val savedModel = models.preference
            models.selectAutoElsewhere()
            val fixture = ProactiveSettingsApiFixture(api)
            val firstRead = CountDownLatch(1)
            fixture.beforeMorningRead = { check(firstRead.await(15, TimeUnit.SECONDS)) }
            app.chatService = api.service
            app.recoveryService = api.service
            app.proactivePreferencesService = api.service.proactivePreferences
            app.initialPreferences =
                testPreferences()
                    .copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Kathmandu",
                        cloudBrowserEnabledByDefault = true,
                    )
            auth.state.value =
                testAuthenticationState(user = "proactive-light-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    settings()
                    val entry = showEntry()
                    assertTrue(fixture.reads.none { it != "eligibility" })
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
                    contains("部分开启")
                    capture("proactive-partial.png")
                    contains("部分开启").click()
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
                    contains("请先选择时区以安排发送。")
                    check(!toggle("晨报", false).isEnabled)
                    capture("proactive-timezone.png")
                    tabTo("时区")
                    check(device.pressEnter())
                    text("用于新建定时任务的默认时区。")
                    awaitFocus("加德满都（UTC+5:45）")
                    capture("proactive-timezone-picker.png")
                    check(device.pressDPadDown())
                    awaitFocus("比什凯克（UTC+6）")
                    scenario.onActivity {
                        check(app.snapshotApiPreferences().values.none { it.timezone == "Asia/Bishkek" })
                    }
                    fixture.morningNeedsTimezone = false
                    check(device.pressEnter())
                    awaitFocus("晨报")
                    check(toggle("晨报", false).isEnabled)
                    scenario.onActivity {
                        check(app.snapshotApiPreferences().values.any { it.timezone == "Asia/Bishkek" })
                    }
                    capture("proactive-timezone-return.png")
                }

                val failureUser = "proactive-timezone-failure-${UUID.randomUUID()}"
                auth.state.value = testAuthenticationState(user = failureUser)
                fixture.morningNeedsTimezone = true
                var reject = true
                var scheduleConflict = true
                app.preferenceWrite = { _, save ->
                    if (reject) {
                        reject = false
                        throw ApiFailure.Http(400, "BAD_REQUEST", null, null)
                    }
                    save().also {
                        fixture.morningNeedsTimezone = false
                        if (scheduleConflict) {
                            scheduleConflict = false
                            throw ApiFailure.Http(409, "CONFLICT", null, null)
                        }
                    }
                }
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    settings()
                    showEntry().click()
                    contains("请先选择时区以安排发送。")
                    fun chooseBishkek() {
                        tabTo("时区")
                        check(device.pressEnter())
                        awaitFocus("加德满都（UTC+5:45）")
                        check(device.pressDPadDown())
                        awaitFocus("比什凯克（UTC+6）")
                        check(device.pressEnter())
                    }
                    fun checkStoredTimezone(timezone: String) {
                        scenario.onActivity {
                            val stored = app.snapshotApiPreferences().entries.single {
                                it.key.second == failureUser
                            }.value
                            check(stored.timezone == timezone)
                        }
                    }
                    chooseBishkek()
                    text("未能保存时区，已恢复原值。")
                    awaitFocus("时区")
                    checkStoredTimezone("Asia/Kathmandu")
                    capture("proactive-timezone-rejected.png")

                    chooseBishkek()
                    text("时区已保存，晨报时间未能更新。")
                    awaitFocus("晨报")
                    checkStoredTimezone("Asia/Bishkek")
                    val retry = text("重试")
                    check(device.wait(Until.gone(selector().text("未能保存时区，已恢复原值。")), 2_000))
                    capture("proactive-timezone-schedule-failed.png")
                    retry.click()
                    check(device.wait(Until.gone(selector().text("时区已保存，晨报时间未能更新。")), 12_000))
                    checkStoredTimezone("Asia/Bishkek")

                    returning()
                    fixture.suggestionsNeedsTimezone = true
                    app.preferenceWrite = { _, save ->
                        save().also { fixture.suggestionsNeedsTimezone = false }
                    }
                    text("主动服务").click()
                    contains("请先选择时区以安排发送。")
                    tabTo("比什凯克（UTC+6）")
                    check(device.pressEnter())
                    text("用于新建定时任务的默认时区。")
                    awaitFocus("比什凯克（UTC+6）")
                    check(device.pressEnter())
                    awaitFocus("建议")
                    check(device.wait(Until.gone(selector().text("时区")), 12_000))
                    capture("proactive-timezone-suggestions-return.png")
                }
                app.preferenceWrite = originalPreferenceWrite

                auth.state.value =
                    testAuthenticationState(user = "region-timezone-${UUID.randomUUID()}")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    openRegionTimezone()
                    text("加德满都（UTC+5:45）")
                    val noteBounds = text("用于新建定时任务的默认时区。").visibleBounds
                    scenario.onActivity {
                        val statusBar = checkNotNull(ViewCompat.getRootWindowInsets(it.window.decorView))
                            .getInsets(WindowInsetsCompat.Type.statusBars()).top
                        check(noteBounds.top > statusBar) {
                            "The portrait selector help must stay below the status bar"
                        }
                    }
                    capture("region-timezone-picker.png")
                }

                device.executeShellCommand("wm size 720x800")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    scenario.onActivity {
                        check(it.resources.configuration.screenWidthDp in 640..839)
                    }
                    openRegionTimezone()
                    text("加德满都（UTC+5:45）")
                    capture("region-timezone-medium.png")
                }
                models.preference = savedModel
                auth.state.value =
                    testAuthenticationState(user = "settings-model-${UUID.randomUUID()}")
                ActivityScenario.launch(MainActivity::class.java).use {
                    settings()
                    text("GPT 5.6 Sol")
                    text("默认模型").click()
                    text("快速模式")
                    capture("settings-model-medium.png")
                }
                models.selectAutoElsewhere()

                device.executeShellCommand("wm size 412x892")
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

                device.executeShellCommand("wm size 960x600")
                device.executeShellCommand("settings put system font_scale 1.0")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    scenario.onActivity {
                        check(it.resources.configuration.screenWidthDp >= 840)
                        check(it.resources.configuration.screenHeightDp >= 480)
                    }
                    openRegionTimezone()
                    text("用于新建定时任务的默认时区。")
                    text("加德满都（UTC+5:45）")
                    capture("region-timezone-wide.png")
                }

                device.executeShellCommand("wm size 412x440")
                device.executeShellCommand("settings put system font_scale 2.0")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    scenario.onActivity { check(it.resources.configuration.fontScale >= 1.99f) }
                    openRegionTimezone()
                    val note = "用于新建定时任务的默认时区。"
                    text(note)
                    val startingZone = "加德满都（UTC+5:45）"
                    text(startingZone)
                    device.waitForIdle()
                    val noteBounds = text(note).visibleBounds
                    val titleBounds = checkNotNull(
                        device.findObjects(selector().text("时区"))
                            .map { it.visibleBounds }
                            .filter { it.bottom <= noteBounds.top }
                            .maxByOrNull { it.bottom },
                    )
                    val headerWidth = maxOf(titleBounds.right, noteBounds.right) - titleBounds.left
                    val headerHeight = noteBounds.bottom - titleBounds.top
                    fun headerPixels(): IntArray {
                        val bitmap = takeScreenshot()
                        try {
                            return IntArray(headerWidth * headerHeight).also {
                                bitmap.getPixels(
                                    it, 0, headerWidth, titleBounds.left, titleBounds.top,
                                    headerWidth, headerHeight,
                                )
                            }
                        } finally {
                            bitmap.recycle()
                        }
                    }
                    capture("region-timezone-short-open.png")
                    val openHeader = headerPixels()
                    var bottomInset = 0
                    scenario.onActivity {
                        bottomInset = checkNotNull(ViewCompat.getRootWindowInsets(it.window.decorView))
                            .getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
                    }
                    val listBottom = device.displayHeight - bottomInset - 24
                    val listTop = noteBounds.bottom + 24
                    check(listBottom > listTop)
                    val centerX = device.displayWidth / 2
                    check(device.swipe(centerX, listBottom, centerX, listTop, 15))
                    check(device.wait(Until.gone(selector().text(startingZone)), 12_000)) {
                        "The short-window option list did not scroll past the selected row"
                    }
                    capture("region-timezone-short.png")
                    text(note)
                    check(openHeader.contentEquals(headerPixels())) {
                        "Short-window header pixels changed while the options scrolled"
                    }
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
                app.preferenceWrite = originalPreferenceWrite
                app.proactivePreferencesService = originalProactive
                app.chatService = originalChats
                app.recoveryService = originalRecovery
                auth.state.value = originalAuth
            }
        }
    }
}
