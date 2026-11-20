package ai.okou.android

import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateRecord
import ai.okou.android.updates.UpdateService
import ai.okou.android.updates.UpdateStore
import ai.okou.android.updates.UpdateTransfer
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
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
    fun updateSharesProgressWaitsForTheMenuAndKeepsTheRequiredGateAcrossRecreation() =
        verifyJourney {
            takeScreenshot().writeToTestStorage("android-update-$it")
        }

    internal fun verifyJourney(
        continueInSystem: ((UiDevice, TestOkouApplication) -> Unit)? = null,
        capture: (String) -> Unit,
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val gate = CompletableDeferred<Unit>()
        val download = CompletableDeferred<File>()
        val release =
            AndroidUpdatesRelease(
                "99.0.0",
                24,
                10_200_000,
                "a".repeat(64),
                "https://static.okou.io/android-updates/releases/99.0.0/${"a".repeat(64)}.apk",
                "",
            )
        val failFirstCheck = AtomicBoolean(true)
        val candidate = AtomicReference(release.copy(version = BuildConfig.VERSION_NAME))
        val file = File(app.filesDir, "updates/native-update-fixture.apk")
        val owner =
            AppUpdates(
                object : UpdateService {
                    override suspend fun initialize() = Unit

                    override suspend fun check(): AndroidUpdates {
                        gate.await()
                        if (failFirstCheck.getAndSet(false))
                            throw IOException("fixture check failed")
                        return AndroidUpdates(null, candidate.get())
                    }

                    override suspend fun recover(release: AndroidUpdatesRelease): File? =
                        file.takeIf(File::isFile)

                    override suspend fun download(
                        release: AndroidUpdatesRelease,
                        progress: (Long) -> Unit,
                    ): File {
                        progress(release.size / 2)
                        return download.await()
                    }

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
            fun button(value: String) =
                generateSequence(requireNotNull(text(value))) { it.parent }.first { it.isClickable }
            fun click(label: Int) = requireNotNull(text(app.getString(label))).click()
            fun exists(label: Int) = assertNotNull(text(app.getString(label)))
            fun captureState(name: String) {
                device.waitForIdle()
                capture(name)
            }
            device.awaitChatList(app)
            val updateTarget = app.getString(R.string.updates_target, "99.0.0")
            fun closeDetails() {
                device.pressBack()
                assertTrue(
                    device.wait(Until.gone(By.pkg(app.packageName).text(updateTarget)), 10_000)
                )
                exists(R.string.updates_title)
            }
            fun backToChatList() {
                device.pressBack()
                device.awaitChatList(app)
            }
            requireNotNull(
                    device.wait(Until.findObject(By.desc(app.getString(R.string.settings))), 10_000)
                )
                .click()
            click(R.string.updates_title)
            exists(R.string.updates_checking)
            captureState("details-checking.png")
            gate.complete(Unit)
            exists(R.string.updates_error_check)
            captureState("details-check-failed.png")
            click(R.string.retry)
            exists(R.string.updates_current)
            captureState("details-up-to-date.png")
            candidate.set(release)
            click(R.string.updates_check)
            assertNotNull(text(updateTarget))
            closeDetails()
            backToChatList()

            val updateAction = app.getString(R.string.updates_toolbar)
            val updateBounds = button(updateAction).visibleBounds
            captureState("toolbar-available.png")
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
            // Dismissing a popup can leave no accessibility acknowledgement for UiDevice.click.
            device.click(updateBounds.centerX(), updateBounds.centerY())
            assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(inbox)), 10_000))
            assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(filter)), 10_000))
            assertFalse(device.hasObject(By.pkg(app.packageName).text(updateTarget)))
            fun openOverflow() =
                requireNotNull(device.wait(Until.findObject(By.desc(moreLabel)), 10_000)).click()
            openOverflow()
            click(R.string.settings)
            exists(R.string.updates_new_version)
            captureState("settings-available.png")
            click(R.string.updates_title)
            assertNotNull(text(updateTarget))
            captureState("details-available.png")
            closeDetails()
            backToChatList()
            requireNotNull(text(updateAction)).click()
            val percent = "50%"
            assertEquals(updateBounds, button(percent).visibleBounds)
            assertFalse(device.hasObject(By.pkg(app.packageName).text(updateTarget)))
            captureState("toolbar-progress.png")
            requireNotNull(text(percent)).click()
            assertNotNull(text(updateTarget))
            assertNotNull(text(app.getString(R.string.updates_downloading, percent)))
            captureState("details-progress.png")
            click(R.string.updates_close)
            assertTrue(owner.state.value.transfer is UpdateTransfer.Downloading)

            openOverflow()
            click(R.string.settings)
            assertNotNull(text(app.getString(R.string.updates_downloading, percent)))
            captureState("settings-progress.png")
            backToChatList()

            openOverflow()
            assertNotNull(text(filter))
            check(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs())
            if (continueInSystem == null)
                file.writeText("verified package from the service fixture")
            else File(app.applicationInfo.sourceDir).copyTo(file, overwrite = true)
            download.complete(file)
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) = owner.state.value.canInstall
                    },
                    10_000,
                )
            )
            assertNotNull(text(filter))
            assertFalse(
                device.hasObject(
                    By.pkg(app.packageName).text(app.getString(R.string.updates_allow_install))
                )
            )
            device.pressBack()
            exists(R.string.updates_open_settings)
            captureState("install-permission.png")
            if (continueInSystem == null) click(R.string.updates_later)
            else continueInSystem(device, app)
            exists(R.string.updates_install_toolbar)
            captureState("toolbar-ready.png")
            openOverflow()
            click(R.string.settings)
            exists(R.string.updates_ready)
            captureState("settings-ready.png")

            candidate.set(release.copy(version = "99.1.0"))
            owner.requireUpdate(RequiredUpdate("99.1.0"))
            exists(R.string.updates_required)
            exists(R.string.updates_toolbar)
            captureState("update-required.png")
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            exists(R.string.updates_required)
            scenario.recreate()
            exists(R.string.updates_required)
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
                    { file.delete() },
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
