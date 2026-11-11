package ai.okou.android

import android.app.UiModeManager
import android.content.res.Configuration
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.datastore.preferences.core.emptyPreferences
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

/** Actual framework/window/input coverage on the API 35 managed phone; no test input adapter. */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 35)
class NativeShellTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val automation = instrumentation.uiAutomation
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as OkouApplication
    private var scenario: ActivityScenario<MainActivity>? = null

    @Test
    fun imeBackAndActivityRecreationRetainTheNativeEditor() =
        onIsolatedDevice("editor") {
            launch()
            editor().click()
            awaitActivity("IME becomes visible") { imeVisible(it) }
            val draft = "Native CI draft"
            editor().text = draft
            assertTrue(device.pressBack())
            awaitActivity("Back dismisses the IME") { !imeVisible(it) }
            editor(draft)
            val selection =
                Bundle().apply {
                    putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 3)
                    putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, 3)
                }
            assertTrue(
                editorNode(draft)
                    .performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection)
            )
            await("Native caret moves") { editorNode(draft).textSelectionStart == 3 }
            click(R.string.settings)
            text(R.string.appearance)
            requireNotNull(scenario).recreate()
            text(R.string.appearance)
            assertTrue(device.pressBack())
            editor(draft)
            assertEquals(3, editorNode(draft).textSelectionStart)
            assertEquals(3, editorNode(draft).textSelectionEnd)
            click(R.string.local_preview)
            text(R.string.preview_title)
        }

    @Test
    fun manualAppearanceRestoresWithANewActivityOwnerAndNativeBars() =
        onIsolatedDevice("appearance") {
            launch()
            var systemDark = false
            requireNotNull(scenario).onActivity { systemDark = isNight(it) }
            val manual = if (systemDark) R.string.appearance_light else R.string.appearance_dark
            click(R.string.settings)
            awaitSelectable(R.string.appearance_system)
            click(manual)
            awaitSelected(manual)
            awaitBars(light = systemDark)
            closeActivity()
            launch()
            awaitBars(light = systemDark)
            click(R.string.settings)
            awaitSelected(manual)
            click(R.string.appearance_system)
            awaitSelected(R.string.appearance_system)
            awaitBars(light = !systemDark)
        }

    @Test
    fun followSystemRespondsToPlatformNightChangesAndKeepsTheDestination() =
        onIsolatedDevice("system-appearance") {
            val mode = requireNotNull(app.getSystemService(UiModeManager::class.java))
            mode.nightMode = UiModeManager.MODE_NIGHT_NO
            launch()
            awaitActivity("Android initial light configuration applies") { !isNight(it) }
            awaitBars(light = true)
            editor().text = "Retained during platform configuration changes"
            click(R.string.settings)
            awaitSelectable(R.string.appearance_system)
            mode.nightMode = UiModeManager.MODE_NIGHT_YES
            awaitActivity("Android night configuration applies") { isNight(it) }
            awaitSelected(R.string.appearance_system)
            awaitBars(light = false)
            mode.nightMode = UiModeManager.MODE_NIGHT_NO
            awaitActivity("Android light configuration applies") { !isNight(it) }
            awaitSelected(R.string.appearance_system)
            awaitBars(light = true)
            assertTrue(device.pressBack())
            editor("Retained during platform configuration changes")
        }

    private fun launch() {
        check(scenario == null)
        scenario = ActivityScenario.launch(MainActivity::class.java)
        editor()
    }

    private fun closeActivity() {
        scenario?.close()
        scenario = null
    }

    private fun editor(value: String? = null): UiObject2 {
        val selector = By.pkg(app.packageName).clazz("android.widget.EditText")
        return requireNotNull(
            device.wait(
                Until.findObject(if (value == null) selector else selector.text(value)),
                WAIT,
            )
        ) {
            "Native draft editor not found: $value"
        }
    }

    private fun text(id: Int): UiObject2 =
        requireNotNull(device.wait(Until.findObject(label(id)), WAIT)) {
            "Native control not found: ${app.getString(id)}"
        }

    private fun label(id: Int): BySelector = By.pkg(app.packageName).text(app.getString(id))

    private fun click(id: Int) = text(id).click()

    // Compose exposes the label as a child of the native checkable option.
    private fun appearanceOption(id: Int): BySelector =
        By.pkg(app.packageName).checkable(true).hasDescendant(label(id))

    private fun awaitSelectable(id: Int) =
        await("Appearance controls finish loading") {
            device.hasObject(appearanceOption(id).enabled(true))
        }

    private fun awaitSelected(id: Int) =
        await("Confirmed appearance selection: ${app.getString(id)}") {
            device.hasObject(appearanceOption(id).checked(true).enabled(true))
        }

    private fun awaitBars(light: Boolean) =
        awaitActivity("Native system bars follow the resolved app appearance") { activity ->
            val controller =
                WindowCompat.getInsetsController(activity.window, activity.window.decorView)
            controller.isAppearanceLightStatusBars == light &&
                controller.isAppearanceLightNavigationBars == light
        }

    private fun awaitActivity(description: String, check: (MainActivity) -> Boolean) =
        await(description) {
            var matches = false
            instrumentation.runOnMainSync {
                val activity =
                    ActivityLifecycleMonitorRegistry.getInstance()
                        .getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<MainActivity>()
                        .singleOrNull()
                matches = activity?.let(check) == true
            }
            matches
        }

    private fun await(description: String, check: () -> Boolean) {
        assertTrue(
            description,
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice) = check()
                },
                WAIT,
            ) == true,
        )
    }

    private fun editorNode(value: String): AccessibilityNodeInfo {
        // Walk the real virtual nodes: Compose does not implement the provider's text search.
        val pending = ArrayDeque<AccessibilityNodeInfo>()
        pending.add(requireNotNull(automation.rootInActiveWindow))
        while (pending.isNotEmpty()) {
            val node = pending.removeFirst()
            if (
                node.packageName?.toString() == app.packageName &&
                    node.className?.toString() == "android.widget.EditText" &&
                    node.text?.toString() == value &&
                    node.isEditable
            ) {
                return node
            }
            repeat(node.childCount) { index -> node.getChild(index)?.let(pending::addLast) }
        }
        error("Native editable draft not found: $value")
    }

    private fun imeVisible(activity: MainActivity): Boolean =
        ViewCompat.getRootWindowInsets(activity.window.decorView)
            ?.isVisible(WindowInsetsCompat.Type.ime()) == true

    private fun isNight(activity: MainActivity): Boolean =
        activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES

    /** Capture before cleanup; preserve every primary/diagnostic/restoration failure. */
    private fun onIsolatedDevice(name: String, test: () -> Unit) {
        val store = app.appearancePreferences
        val preferences = runBlocking { store.data.first() }
        val resolver = app.contentResolver
        val keyboard = Settings.Secure.getString(resolver, SHOW_IME_WITH_HARD_KEYBOARD)
        val mode = requireNotNull(app.getSystemService(UiModeManager::class.java))
        val nightMode = mode.nightMode
        val failures = mutableListOf<Throwable>()
        try {
            automation.adoptShellPermissionIdentity(
                "android.permission.MODIFY_DAY_NIGHT_MODE",
                "android.permission.WRITE_SECURE_SETTINGS",
            )
            assertTrue(Settings.Secure.putString(resolver, SHOW_IME_WITH_HARD_KEYBOARD, "1"))
            runBlocking { store.updateData { emptyPreferences() } }
            test()
        } catch (failure: Throwable) {
            failures += failure
            try {
                takeScreenshot().writeToTestStorage("$name-failure")
            } catch (diagnostic: Throwable) {
                failure.addSuppressed(diagnostic)
            }
            try {
                TestStorage().openOutputFile("$name-hierarchy.xml").use {
                    device.dumpWindowHierarchy(it)
                }
            } catch (diagnostic: Throwable) {
                failure.addSuppressed(diagnostic)
            }
        } finally {
            fun restore(action: () -> Unit) {
                try {
                    action()
                } catch (failure: Throwable) {
                    failures += failure
                }
            }
            restore { closeActivity() }
            restore { runBlocking { store.updateData { preferences } } }
            restore {
                assertTrue(
                    Settings.Secure.putString(resolver, SHOW_IME_WITH_HARD_KEYBOARD, keyboard)
                )
            }
            restore { mode.nightMode = nightMode }
            restore { automation.dropShellPermissionIdentity() }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private companion object {
        const val WAIT = 10_000L
        const val SHOW_IME_WITH_HARD_KEYBOARD = "show_ime_with_hard_keyboard"
    }
}
