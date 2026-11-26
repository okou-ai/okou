package ai.okou.android.screenshots

import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitKeyboardFocus
import ai.okou.android.resolvePalette
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Color
import android.graphics.Rect
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.RippleDefaults
import androidx.compose.ui.graphics.toArgb
import androidx.core.graphics.ColorUtils
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val automation = instrumentation.uiAutomation
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val labels = listOf("说明", "自动化", "运行记录")

    @Test
    @OptIn(ExperimentalMaterial3Api::class)
    fun material3WorkflowDetailTabs() {
        assertEquals(0.10f, RippleDefaults.RippleAlpha.pressedAlpha, 0.001f)
        assertEquals(0.08f, RippleDefaults.RippleAlpha.hoveredAlpha, 0.001f)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val previousComposer = app.composerService
        val previousWorkflows = app.workflows
        val previousConnectors = app.connectorService
        val previousPreferences = app.initialPreferences
        val previousPreferenceData = app.snapshotApiPreferences()
        val originalSize = displayOverride("size", "\\d+x\\d+")
        val originalDensity = displayOverride("density", "\\d+")
        val originalScale = device.executeShellCommand("settings get system font_scale").trim()
        val fixture = WorkflowApiFixture(chinese = true)
        val connectors = ConnectorApiFixture()
        val normalHistory = fixture.firstRunHistory

        try {
            fixture.active.set(true)
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.workflows = fixture.service
            app.connectorService = connectors.service
            auth.state.value =
                testAuthenticationState(
                    user = "user-a",
                    session = "workflow-tabs-${UUID.randomUUID()}",
                )
            device.executeShellCommand("wm density 160")

            val oldest = normalHistory.runs.last()
            val date = Instant.parse(oldest.createdAt)
            fixture.firstRunHistory =
                normalHistory.copy(
                    runs =
                        normalHistory.runs +
                            (1..16).map { day ->
                                oldest.copy(
                                    id = UUID.randomUUID().toString(),
                                    createdAt =
                                        date.minus(day.toLong(), ChronoUnit.DAYS).toString(),
                                    chatThreadId = null,
                                )
                            },
                )

            verifyWindow(412, 892, UserPreferencesTheme.LIGHT) {
                openDetail(fixture.releaseTitle)
                assertSelected("说明")
                val initialTabs = checkTabGeometry()
                ScreenshotCapture.capture("phone-instructions.png")

                val bounds = initialTabs[1]
                val x = bounds.left + 24
                val y = bounds.centerY()
                val colors = resolvePalette(UserPreferencesColorTheme.DEFAULT, dark = false)
                val background = colors.background.toArgb()
                val primary = colors.primary.toArgb()
                injectHover(x, y)
                try {
                    awaitPixel(
                        x,
                        y,
                        ColorUtils.compositeColors(
                            ColorUtils.setAlphaComponent(primary, 20),
                            background,
                        ),
                    )
                    assertSelected("说明")
                    ScreenshotCapture.capture("phone-tab-hover.png")
                } finally {
                    injectHover(x, y - bounds.height())
                }
                awaitPixel(x, y, background)

                tab("自动化").click()
                text("添加自动化")
                assertSelected("自动化")
                ScreenshotCapture.capture("phone-automations.png")

                tab("运行记录").click()
                text("运行中")
                assertSelected("运行记录")
                val history = tab("运行记录").visibleBounds
                val footer = action("在聊天中使用").visibleBounds
                val scrollX = history.centerX()
                assertTrue(footer.height() >= 48)
                assertTrue(device.swipe(scrollX, footer.top - 20, scrollX, history.bottom + 18, 30))
                val pinned = tab("运行记录").visibleBounds
                assertTrue(
                    "The header scrolls before the tab row becomes sticky",
                    pinned.top < history.top,
                )
                assertTrue(device.swipe(scrollX, footer.top - 20, scrollX, pinned.bottom + 18, 30))
                assertEquals(pinned.top, tab("运行记录").visibleBounds.top)
                checkTabGeometry()
                ScreenshotCapture.capture("phone-history-sticky.png")

                tab("说明").click()
                action("编辑说明").click()
                val displayName = input(fixture.releaseTitle)
                val purposeTop = text("用途").visibleBounds.top
                input(fixture.instruction)
                ScreenshotCapture.capture("phone-instructions-editor.png")
                displayName.text = " "
                text("请输入显示名称。")
                assertEquals(purposeTop, text("用途").visibleBounds.top)
                assertTrue(
                    "Invalid input disables Save",
                    generateSequence(text("保存")) { it.parent }.any { !it.isEnabled },
                )
                ScreenshotCapture.capture("phone-instructions-error.png")
                input(" ").text = fixture.releaseTitle
                assertTrue(
                    device.wait(Until.gone(By.pkg(app.packageName).text("请输入显示名称。")), 5_000),
                )
                assertEquals(purposeTop, text("用途").visibleBounds.top)
            }

            fixture.firstRunHistory = normalHistory
            verifyWindow(1180, 820, UserPreferencesTheme.DARK) {
                openDetail(fixture.releaseTitle)
                val first = "说明"
                instrumentation.setInTouchMode(false)
                val focusTarget = tab(first).accessibilityNodeInfo
                assertTrue(
                    focusTarget.isFocused ||
                        focusTarget.performAction(AccessibilityNodeInfo.ACTION_FOCUS),
                )
                awaitFocus(first)
                assertTrue(device.pressDPadRight())
                awaitFocus("自动化")
                assertSelected("自动化")
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_MOVE_END))
                awaitFocus("运行记录")
                text("运行中")
                assertSelected("运行记录")
                val tabs = checkTabGeometry()
                assertEquals(tabs.last().right, action("在聊天中使用").visibleBounds.right)
                ScreenshotCapture.capture("wide-history-keyboard.png")
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_MOVE_HOME))
                awaitFocus(first)
                text("工作流说明")
                assertSelected(first)
                instrumentation.setInTouchMode(true)

                tab("自动化").click()
                action("添加自动化").click()
                val frequency = action("工作日")
                assertTrue(frequency.visibleBounds.height() >= 56)
                frequency.click()
                action("每天").click()
                text("每天")
                val time = action("09:00")
                assertTrue(time.visibleBounds.height() >= 56)
                ScreenshotCapture.capture("wide-schedule-editor.png")
                time.click()
                assertTrue(
                    "Expected the native Android time picker",
                    device.wait(Until.hasObject(By.res("android", "button1")), 10_000),
                )
                ScreenshotCapture.capture("wide-native-time-picker.png")
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            }

            verifyWindow(240, 892, UserPreferencesTheme.LIGHT, fontScale = 2f) {
                openDetail(fixture.releaseTitle)
                action("编辑说明").click()
                val name = input(fixture.releaseTitle)
                val purposeTop = text("用途").visibleBounds.top
                val longName = "x".repeat(257)
                name.text = longName
                text("最多输入 256 个字符。")
                device.waitForIdle()
                assertTrue(text("用途").visibleBounds.top > purposeTop)
                ScreenshotCapture.capture("narrow-wrapped-validation.png")
                input(longName).text = fixture.releaseTitle
                assertTrue(
                    device.wait(Until.gone(By.pkg(app.packageName).text("最多输入 256 个字符。")), 5_000),
                )
                device.waitForIdle()
                assertEquals(purposeTop, text("用途").visibleBounds.top)
            }
        } finally {
            try {
                app.chatService = previousChats
                app.composerService = previousComposer
                app.workflows = previousWorkflows
                app.connectorService = previousConnectors
                app.initialPreferences = previousPreferences
                app.restoreApiPreferences(previousPreferenceData)
                auth.state.value = previousAuth
                connectors.use { fixture.close() }
            } finally {
                instrumentation.resetInTouchMode()
                if (originalScale.toFloatOrNull() == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else {
                    device.executeShellCommand("settings put system font_scale $originalScale")
                }
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
                device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            }
        }
    }

    private fun verifyWindow(
        width: Int,
        height: Int,
        theme: UserPreferencesTheme,
        fontScale: Float = 1f,
        verify: () -> Unit,
    ) {
        app.restoreApiPreferences(emptyMap())
        app.initialPreferences =
            testPreferences()
                .copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = theme,
                    timezone = "Asia/Shanghai",
                )
        device.executeShellCommand("wm size ${width}x${height}")
        device.executeShellCommand("settings put system font_scale $fontScale")
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            try {
                scenario.onActivity {
                    assertEquals(width, it.resources.configuration.screenWidthDp)
                    assertEquals(160, it.resources.configuration.densityDpi)
                    assertEquals(fontScale, it.resources.configuration.fontScale, 0.001f)
                }
                verify()
            } catch (error: Throwable) {
                runCatching {
                    TestStorage()
                        .openOutputFile("capture-failure.xml")
                        .use(device::dumpWindowHierarchy)
                    ScreenshotCapture.capture("capture-failure.png")
                }
                throw error
            }
        }
    }

    private fun displayOverride(setting: String, pattern: String): String? =
        Regex("Override $setting: ($pattern)")
            .find(device.executeShellCommand("wm $setting"))
            ?.groupValues
            ?.get(1)

    private fun openDetail(title: String) {
        text("Personal chat")
        checkNotNull(
                device.wait(
                    Until.findObject(By.pkg(app.packageName).desc("工作流").enabled(true)),
                    10_000,
                ),
            )
            .click()
        action(title).click()
        text("工作流说明")
    }

    private fun text(label: String): UiObject2 =
        checkNotNull(device.wait(Until.findObject(By.pkg(app.packageName).text(label)), 15_000)) {
            "Missing native text: $label"
        }

    private fun input(value: String): UiObject2 =
        checkNotNull(
            device.wait(
                Until.findObject(
                    By.pkg(app.packageName).clazz("android.widget.EditText").text(value),
                ),
                10_000,
            ),
        ) {
            "Missing native text input: $value"
        }

    private fun action(label: String): UiObject2 =
        checkNotNull(generateSequence(text(label)) { it.parent }.firstOrNull { it.isClickable }) {
            "Missing native action: $label"
        }

    private fun assertSelected(selected: String) {
        device.waitForIdle()
        labels.forEach { label -> assertEquals(label, label == selected, tab(label).isSelected) }
    }

    private fun tab(label: String): UiObject2 =
        checkNotNull(generateSequence(text(label)) { it.parent }.firstOrNull { it.isFocusable }) {
            "Missing native tab: $label"
        }

    private fun awaitFocus(label: String) =
        device.awaitKeyboardFocus(By.pkg(app.packageName).text(label))

    private fun checkTabGeometry(): List<Rect> {
        val bounds = labels.map { tab(it).visibleBounds }
        val first = bounds.first()
        for (tab in bounds) {
            assertTrue(tab.height() >= 48)
            assertEquals(first.top, tab.top)
            assertEquals(first.bottom, tab.bottom)
            assertTrue(abs(first.width() - tab.width()) <= 1)
        }
        bounds.zipWithNext().forEach { (left, right) -> assertEquals(left.right, right.left) }
        return bounds
    }

    private fun injectHover(x: Int, y: Int) {
        val now = SystemClock.uptimeMillis()
        val property =
            MotionEvent.PointerProperties().apply {
                id = 0
                toolType = MotionEvent.TOOL_TYPE_MOUSE
            }
        val point =
            MotionEvent.PointerCoords().apply {
                this.x = x.toFloat()
                this.y = y.toFloat()
                size = 1f
            }
        val event =
            MotionEvent.obtain(
                now,
                now,
                MotionEvent.ACTION_HOVER_MOVE,
                1,
                arrayOf(property),
                arrayOf(point),
                0,
                0,
                1f,
                1f,
                0,
                0,
                InputDevice.SOURCE_MOUSE,
                0,
            )
        try {
            assertTrue("Android mouse hover", automation.injectInputEvent(event, true))
        } finally {
            event.recycle()
        }
    }

    private fun awaitPixel(x: Int, y: Int, expected: Int) {
        var lastColor: Int? = null
        val expectedPixel =
            object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean {
                    val bitmap = automation.takeScreenshot() ?: return false
                    try {
                        val actual = bitmap.getPixel(x, y)
                        lastColor = actual
                        return abs(Color.red(actual) - Color.red(expected)) <= 2 &&
                            abs(Color.green(actual) - Color.green(expected)) <= 2 &&
                            abs(Color.blue(actual) - Color.blue(expected)) <= 2
                    } finally {
                        bitmap.recycle()
                    }
                }
            }
        check(device.wait(expectedPixel, 8_000)) {
            "Expected pixel ${expected.toUInt().toString(16)} at $x,$y, read ${lastColor?.toUInt()?.toString(16)}"
        }
    }
}
