package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun automaticProjectVerificationRestoresEditableCreate() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalService = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val firstLookup = CountDownLatch(1)
        val releaseLookup = CountDownLatch(1)
        val operationId = AtomicReference<String>()
        val writes = AtomicInteger()
        val reads = AtomicInteger()
        val committed = AtomicBoolean()
        val name = "Field research"
        val fixture = ChatListApiFixture()
        fixture.commandResponse = { request ->
            if (request.method == "POST" && request.path == "/api/projects") {
                val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                val id = body.getValue("id").jsonPrimitive.content
                operationId.compareAndSet(null, id)
                check(id == operationId.get() && id == body.getValue("eventId").jsonPrimitive.content)
                check(name == body.getValue("name").jsonPrimitive.content)
                writes.incrementAndGet()
                MockResponse().setResponseCode(503).setHeader("Retry-After", "0")
            } else if (request.method == "GET" && request.path == "/api/projects/${operationId.get()}") {
                if (reads.incrementAndGet() == 1) {
                    firstLookup.countDown()
                    check(releaseLookup.await(20, TimeUnit.SECONDS))
                }
                if (committed.get()) {
                    jsonResponse(
                        """{"id":"${operationId.get()}","name":"$name","sortOrder":"a0","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}""",
                    )
                } else MockResponse().setResponseCode(404)
            } else null
        }
        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun find(selector: BySelector) = checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }
        fun action(res: Int) = checkNotNull(
            generateSequence(find(text(app.getString(res)))) { it.parent }
                .firstOrNull { it.className == "android.widget.Button" || it.isClickable },
        )
        fun hideKeyboard() {
            if (instrumentation.uiAutomation.windows.any {
                it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD
            }) device.pressBack()
        }
        try {
            app.chatService = fixture.service
            auth.state.value = testAuthenticationState(user = "project-create-recovery-${UUID.randomUUID()}")
            ActivityScenario.launch(MainActivity::class.java).use {
                device.awaitChatList(app)
                find(By.pkg(app.packageName).desc(app.getString(R.string.chat_more_actions))).click()
                find(text(app.getString(R.string.chat_project_create))).click()
                val field = By.pkg(app.packageName).clazz("android.widget.EditText")
                find(field).setText(name)
                hideKeyboard()
                val create = action(R.string.chat_project_create_confirm)
                val initialBounds = create.visibleBounds
                val density = app.resources.displayMetrics.density
                fun pixels(dp: Int) = (dp * density).roundToInt()
                val cancel = action(R.string.chat_rename_cancel).visibleBounds
                check(initialBounds.height() >= pixels(48) && initialBounds.width() >= pixels(89)) {
                    "Create hit target $initialBounds at density $density"
                }
                check(abs(initialBounds.left - cancel.right - pixels(8)) <= 1) {
                    "Expected 8dp action gap between $cancel and $initialBounds"
                }
                create.click()
                check(firstLookup.await(10, TimeUnit.SECONDS))
                try {
                    val checking = action(R.string.chat_project_checking)
                    check(!checking.isEnabled && !action(R.string.chat_rename_cancel).isEnabled)
                    val checkingBounds = checking.visibleBounds
                    check(checkingBounds == initialBounds) {
                        "Checking action $checkingBounds moved from $initialBounds"
                    }
                    ScreenshotCapture.capture("project-checking.png")
                    releaseLookup.countDown()
                    val error = find(text(app.getString(R.string.chat_project_create_failed))).visibleBounds
                    val restored = action(R.string.chat_project_create_confirm)
                    check(restored.isEnabled && restored.visibleBounds == checkingBounds) {
                        "Restored action ${restored.visibleBounds} moved from $checkingBounds"
                    }
                    check(error.top >= find(field).visibleBounds.bottom && error.bottom < restored.visibleBounds.top)
                    check(find(field).text == name)
                    ScreenshotCapture.capture("project-create-failed.png")
                    find(field).setText("Another draft")
                    check(find(field).text == "Another draft")
                    find(field).setText(name)
                    hideKeyboard()
                    val attemptedWrites = writes.get()
                    check(attemptedWrites == 3)
                    committed.set(true)
                    action(R.string.chat_project_create_confirm).click()
                    find(text(app.getString(R.string.composer_new_project)))
                    find(text(name))
                    check(writes.get() == attemptedWrites)
                    ScreenshotCapture.capture("project-created.png")
                } finally {
                    releaseLookup.countDown()
                }
            }
        } finally {
            releaseLookup.countDown()
            auth.state.value = originalAuth
            app.chatService = originalService
            app.restoreApiPreferences(preferences)
            fixture.close()
            cache.restore()
        }
    }
}
