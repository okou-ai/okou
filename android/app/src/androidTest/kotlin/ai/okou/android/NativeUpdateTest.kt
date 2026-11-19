package ai.okou.android

import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateRecord
import ai.okou.android.updates.UpdateService
import ai.okou.android.updates.UpdateStore
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class NativeUpdateTest {
    @Test
    fun initialScreenAndRequiredRecoveryUseIndependentOwnersAcrossRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val gate = CompletableDeferred<Unit>()
        val release =
            AndroidUpdatesRelease(
                "99.0.0",
                24,
                1234,
                "a".repeat(64),
                "https://static.okou.io/android-updates/releases/99.0.0/${"a".repeat(64)}.apk",
                "A native update",
            )
        val owner =
            AppUpdates(
                object : UpdateService {
                    override suspend fun initialize() = Unit

                    override suspend fun check(): AndroidUpdates {
                        gate.await()
                        return AndroidUpdates(null, release)
                    }

                    override suspend fun recover(release: AndroidUpdatesRelease): File? = null

                    override suspend fun download(
                        release: AndroidUpdatesRelease,
                        progress: (Long) -> Unit,
                    ): File = error("No download requested")

                    override fun close() = Unit
                },
                object : UpdateStore {
                    override suspend fun load(): UpdateRecord? = null

                    override suspend fun save(record: UpdateRecord) = Unit
                },
                BuildConfig.VERSION_NAME,
                35,
            )
        val previous = app.updateOwner
        app.updateOwner = owner
        var scenario: ActivityScenario<MainActivity>? = null
        val failures = mutableListOf<Throwable>()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            fun text(value: String) =
                device.wait(Until.findObject(By.pkg(app.packageName).text(value)), 10_000)
            device.awaitChatList(app)
            gate.complete(Unit)
            val updateAction = app.getString(R.string.updates_toolbar)
            val updateCenter = requireNotNull(text(updateAction)).visibleCenter
            assertTrue(
                device.wait(Until.gone(By.desc(app.getString(R.string.chat_filter))), 10_000)
            )
            val more =
                requireNotNull(
                    device.wait(
                        Until.findObject(By.desc(app.getString(R.string.chat_more_actions))),
                        10_000,
                    )
                )
            assertEquals(1, device.findObjects(By.pkg(app.packageName).text(updateAction)).size)
            assertFalse(
                device.hasObject(By.pkg(app.packageName).desc(app.getString(R.string.settings)))
            )
            more.click()
            val filter = app.getString(R.string.chat_filter)
            val inbox = app.getString(R.string.chat_inbox)
            val muted = app.getString(R.string.chat_muted)
            fun awaitMenuFocus(label: String) =
                device.awaitKeyboardFocus(By.pkg(app.packageName).text(label))
            assertNotNull(text(filter))
            assertNotNull(text(app.getString(R.string.settings)))
            instrumentation.setInTouchMode(false)
            awaitMenuFocus(filter)
            assertTrue(device.pressDPadCenter())
            awaitMenuFocus(inbox)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_MOVE_END))
            awaitMenuFocus(muted)
            assertTrue(device.pressDPadDown())
            awaitMenuFocus(inbox)
            assertTrue(device.pressDPadUp())
            awaitMenuFocus(muted)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_MOVE_HOME))
            awaitMenuFocus(inbox)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ESCAPE))
            awaitMenuFocus(filter)
            assertTrue(device.pressDPadCenter())
            awaitMenuFocus(inbox)
            assertTrue(device.pressBack())
            awaitMenuFocus(filter)
            assertTrue(device.pressBack())
            val moreLabel = app.getString(R.string.chat_more_actions)
            device.awaitKeyboardFocus(By.pkg(app.packageName).desc(moreLabel))
            assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(filter)), 10_000))
            assertTrue(device.pressDPadCenter())
            awaitMenuFocus(filter)
            assertTrue(device.pressDPadCenter())
            awaitMenuFocus(inbox)
            assertTrue(device.click(updateCenter.x, updateCenter.y))
            assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(inbox)), 10_000))
            assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(filter)), 10_000))
            requireNotNull(text(updateAction)).click()
            assertNotNull(text(app.getString(R.string.updates_target, "99.0.0")))
            takeScreenshot().writeToTestStorage("android-update-optional.png")
            owner.requireUpdate(RequiredUpdate("99.0.0"))
            assertNotNull(text(app.getString(R.string.updates_required)))
            scenario.recreate()
            assertNotNull(text(app.getString(R.string.updates_required)))
            assertTrue(owner.state.value.required)
            takeScreenshot().writeToTestStorage("android-update-required.png")
        } catch (error: Throwable) {
            failures += error
            try {
                takeScreenshot().writeToTestStorage("android-update-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            gate.complete(Unit)
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { owner.close() },
                    { app.updateOwner = previous },
                    { instrumentation.resetInTouchMode() },
                )) try {
                cleanup()
            } catch (error: Throwable) {
                failures += error
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
