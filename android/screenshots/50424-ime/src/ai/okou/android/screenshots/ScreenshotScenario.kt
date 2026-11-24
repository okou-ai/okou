package ai.okou.android.screenshots

import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.AuthenticationState
import ai.okou.android.auth.ClerkAuthentication
import android.view.KeyEvent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val auth = app.authentication as TestAuthentication
    private val identifier = By.res("clerk.auth.start.identifier")

    @Test
    fun identifierStepAndBrandStayInPlaceWhenImeChanges() {
        val previous = auth.state.value
        val imeWithHardware = device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        val originalSize = overrideValue("wm size")
        val originalDensity = overrideValue("wm density")
        try {
            instrumentation.runOnMainSync { ClerkAuthentication(app).initialize() }
            auth.state.value = AuthenticationState(initialized = true)
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
            captureIme("phone")

            device.executeShellCommand("wm size 840x960")
            device.executeShellCommand("wm density 160")
            captureIme("wide")
        } finally {
            auth.state.value = previous
            device.executeShellCommand("wm size $originalSize")
            device.executeShellCommand("wm density $originalDensity")
            if (imeWithHardware == "null")
                device.executeShellCommand("settings delete secure show_ime_with_hard_keyboard")
            else device.executeShellCommand("settings put secure show_ime_with_hard_keyboard $imeWithHardware")
        }
    }

    private fun captureIme(prefix: String) {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val brand = By.text(app.getString(R.string.app_name))
            val email = checkNotNull(device.wait(Until.findObject(identifier), 20_000))
            val label = checkNotNull(device.wait(Until.findObject(brand), 20_000))
            val brandTop = label.visibleBounds.top
            ScreenshotCapture.capture("$prefix-before-ime.png")
            email.click()
            awaitIme(scenario, visible = true)
            val value = "design-check@example.invalid"
            checkNotNull(device.findObject(identifier)).text = value
            check(checkNotNull(device.findObject(identifier)).text == value)
            check(checkNotNull(device.findObject(brand)).visibleBounds.top == brandTop)
            ScreenshotCapture.capture("$prefix-ime-open.png")
            check(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            awaitIme(scenario, visible = false)
            val field = checkNotNull(device.findObject(identifier))
            check(field.isFocused && field.text == value)
            check(checkNotNull(device.findObject(brand)).visibleBounds.top == brandTop)
            ScreenshotCapture.capture("$prefix-after-ime.png")
        }
    }

    private fun awaitIme(scenario: ActivityScenario<MainActivity>, visible: Boolean) {
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        var matches = false
                        scenario.onActivity { activity ->
                            matches =
                                ViewCompat.getRootWindowInsets(activity.window.decorView)
                                    ?.isVisible(WindowInsetsCompat.Type.ime()) == visible
                        }
                        return matches
                    }
                },
                10_000,
            ) == true,
        ) { "Unexpected IME visibility" }
    }

    private fun overrideValue(command: String): String =
        device.executeShellCommand(command).lineSequence()
            .firstOrNull { it.startsWith("Override ") }
            ?.substringAfter(": ") ?: "reset"
}
