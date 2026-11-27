package ai.okou.android.screenshots

import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.auth.AuthenticationState
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val auth = app.authentication as TestAuthentication

    @Test
    fun membershipReadRecoversAfterARejectedSignOut() {
        val originalState = auth.state.value
        val originalMembershipsAction = auth.membershipsAction
        val originalSignOutAction = auth.signOutAction
        val workspaces = auth.available
        val allowFailures = CompletableDeferred<Unit>()
        val allowRecovery = CompletableDeferred<Unit>()
        val finishSignOut = CompletableDeferred<Unit>()
        val attempts = AtomicInteger()

        try {
            auth.state.value = AuthenticationState()
            auth.membershipsAction = {
                allowFailures.await()
                if (attempts.incrementAndGet() <= 3) throw ApiFailure.Http(429, null, null, 0)
                allowRecovery.await()
                workspaces
            }
            auth.signOutAction = { finishSignOut.await() }

            ActivityScenario.launch(MainActivity::class.java).use {
                auth.state.value = testAuthenticationState(workspace = null)
                find(R.string.auth_preparing_workspace)
                ScreenshotCapture.capture("preparing-workspace.png")

                allowFailures.complete(Unit)
                find(R.string.auth_unavailable)
                check(!device.hasObject(text(R.string.retry)))
                ScreenshotCapture.capture("workspace-unavailable.png")

                find(R.string.auth_sign_out).click()
                find(R.string.settings_sign_out_title)
                ScreenshotCapture.capture("sign-out-confirmation.png")
                checkNotNull(device.findObjects(text(R.string.auth_sign_out)).lastOrNull()).click()
                find(R.string.auth_signing_out)

                finishSignOut.completeExceptionally(IllegalStateException("Fixture sign-out rejected"))
                find(R.string.auth_unavailable)
                find(R.string.auth_sign_out_failed)
                find(R.string.auth_sign_out)
                check(!device.hasObject(text(R.string.retry)))
                ScreenshotCapture.capture("workspace-after-rejected-sign-out.png")

                allowRecovery.complete(Unit)
                find(R.string.auth_choose_workspace)
                find(R.string.auth_sign_out_failed)
                workspaces.forEach { workspace ->
                    val row = By.pkg(app.packageName).text(workspace.name)
                    check(device.wait(Until.hasObject(row), 5_000) == true) {
                        "Timed out waiting for ${workspace.name}"
                    }
                }
                check(attempts.get() == 4)
                ScreenshotCapture.capture("workspace-recovered.png")
            }
        } finally {
            auth.membershipsAction = originalMembershipsAction
            auth.signOutAction = originalSignOutAction
            auth.state.value = originalState
            allowFailures.complete(Unit)
            allowRecovery.complete(Unit)
            finishSignOut.complete(Unit)
        }
    }

    private fun text(resource: Int) = By.pkg(app.packageName).text(app.getString(resource))

    private fun find(resource: Int) =
        checkNotNull(device.wait(Until.findObject(text(resource)), 5_000)) {
            "Timed out waiting for ${app.getString(resource)}"
        }
}
