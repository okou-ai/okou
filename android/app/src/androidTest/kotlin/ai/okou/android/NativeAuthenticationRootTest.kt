package ai.okou.android

import ai.okou.android.auth.AuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeAuthenticationRootTest {
    @Test
    fun pendingAuthenticationDisplaysNativeLoginBeforeAndAfterActivityRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val authentication = app.authentication as TestAuthentication
        val previous = authentication.state.value
        val device = UiDevice.getInstance(instrumentation)
        authentication.state.value = AuthenticationState()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun verify() {
                    assertNotNull(
                        device.wait(
                            Until.findObject(By.text(app.getString(R.string.auth_welcome))),
                            10_000,
                        )
                    )
                    assertFalse(
                        device.hasObject(By.pkg(app.packageName).clazz("android.widget.EditText"))
                    )
                    assertFalse(device.hasObject(By.text(app.getString(R.string.settings))))
                }
                verify()
                scenario.recreate()
                verify()
            }
        } finally {
            authentication.state.value = previous
        }
    }
}
