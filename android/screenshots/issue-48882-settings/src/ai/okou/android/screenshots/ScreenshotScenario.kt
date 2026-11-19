package ai.okou.android.screenshots

import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import android.app.UiModeManager
import android.view.KeyEvent
import androidx.core.view.WindowCompat
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
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val automation = instrumentation.uiAutomation
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication

    @Test
    fun settingsSelectors() {
        val oldPreferences = app.snapshotApiPreferences()
        val mode = requireNotNull(app.getSystemService(UiModeManager::class.java))
        val oldNightMode = mode.nightMode
        automation.adoptShellPermissionIdentity("android.permission.MODIFY_DAY_NIGHT_MODE")
        try {
            mode.nightMode = UiModeManager.MODE_NIGHT_NO
            app.restoreApiPreferences(emptyMap())
            ActivityScenario.launch(MainActivity::class.java).use { activity ->
                find(By.desc("Settings")).click()
                find(button("Appearance"))
                find(label("App updates"))
                find(label("Workspace preferences"))
                awaitBars(activity, light = true)
                find(button("Instructions"))
                find(button("Sign out"))
                ScreenshotCapture.capture("settings.png")

                find(button("Appearance")).click()
                find(option("Follow system").checked(true))
                find(option("Light"))
                find(option("Dark"))
                ScreenshotCapture.capture("appearance.png")
                dismiss("Dark")

                find(button("Color theme")).click()
                find(option("Default").checked(true))
                for (choice in
                    listOf(
                        "Golden hour",
                        "Citrus spark",
                        "Berry blush",
                        "Cotton sky",
                        "Blue horizon",
                        "Daydream",
                        "Deep lagoon",
                    )) {
                    find(option(choice))
                }
                ScreenshotCapture.capture("palette-light.png")
                dismiss("Default")

                find(button("Language")).click()
                find(option("English").checked(true))
                find(option("日本語"))
                reveal(
                    option("繁體中文"),
                    Direction.DOWN,
                    By.pkg(app.packageName).scrollable(true).hasDescendant(option("English")),
                )
                find(option("简体中文"))
                ScreenshotCapture.capture("language.png")
                dismiss("繁體中文")

                find(button("Appearance")).click()
                find(option("Dark")).click()
                find(button("Appearance").hasDescendant(label("Dark")))
                awaitBars(activity, light = false)
                find(button("Color theme")).click()
                find(option("Blue horizon")).click()
                find(button("Color theme").hasDescendant(label("Blue horizon")))
                find(button("Color theme")).click()
                find(option("Blue horizon").checked(true))
                ScreenshotCapture.capture("palette-dark.png")
            }
        } finally {
            try {
                app.restoreApiPreferences(oldPreferences)
                mode.nightMode = oldNightMode
            } finally {
                automation.dropShellPermissionIdentity()
            }
        }
    }

    private fun label(text: String) = By.pkg(app.packageName).text(text)

    private fun option(text: String) =
        By.pkg(app.packageName).checkable(true).hasDescendant(label(text))

    private fun button(text: String) =
        By.pkg(app.packageName)
            .clickable(true)
            .checkable(false)
            .enabled(true)
            .hasDescendant(label(text))

    private fun find(selector: BySelector): UiObject2 =
        requireNotNull(device.wait(Until.findObject(selector), 10_000L)) {
            "Missing visible Settings control: $selector"
        }

    private fun reveal(
        selector: BySelector,
        direction: Direction,
        scrollSelector: BySelector = By.pkg(app.packageName).scrollable(true),
    ) {
        if (device.hasObject(selector)) return
        val scroll = find(scrollSelector)
        check(
            scroll.scrollUntil(
                direction,
                object : Condition<UiObject2, Boolean> {
                    override fun apply(container: UiObject2) = device.hasObject(selector)
                },
            ) == true
        ) {
            "Settings control could not be reached: $selector"
        }
    }

    private fun dismiss(choice: String) {
        check(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
        check(device.wait(Until.gone(option(choice)), 10_000L))
    }

    private fun awaitBars(activity: ActivityScenario<MainActivity>, light: Boolean) {
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        var matches = false
                        activity.onActivity {
                            val insets =
                                WindowCompat.getInsetsController(it.window, it.window.decorView)
                            matches =
                                insets.isAppearanceLightStatusBars == light &&
                                    insets.isAppearanceLightNavigationBars == light
                        }
                        return matches
                    }
                },
                10_000L,
            ) == true
        )
    }
}
