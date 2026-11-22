package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.awaitChatList
import ai.okou.android.jsonResponse
import ai.okou.android.rowEvent
import ai.okou.android.rowEventTail
import ai.okou.android.testAuthenticationState
import android.view.accessibility.AccessibilityNodeInfo
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.net.ConnectException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesConnectionFeedbackAndCompactConfirmation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val savedAuth = auth.state.value
        val savedService = app.chatService
        val savedOnline = app.connectivity.value
        val savedPreferences = app.snapshotApiPreferences()
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val project = "Research and planning for the next customer onboarding and workspace rollout"
        val operationsId = "44444444-4444-4444-8444-444444444445"
        fixture.projects = {
            jsonResponse(
                """{"projects":[{"id":"$CHAT_PROJECT","name":"$project","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"},{"id":"$operationsId","name":"Operations","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}"""
            )
        }
        val events = fixture.rowEventTail()
        val readPersonal = AtomicBoolean()
        fixture.indicators = {
            val unreadPersonal =
                if (readPersonal.get()) "" else ",\"$CHAT_PERSONAL\":\"$CHAT_DATE\""
            jsonResponse(
                """{"threads":{"$CHAT_PERSONAL":"active","$CHAT_IN_PROJECT":"unread"},"unreadAt":{"$CHAT_IN_PROJECT":"$CHAT_DATE"$unreadPersonal}}"""
            )
        }
        fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    events += 24L to request.rowEvent(24, CHAT_PERSONAL, "archived")
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                    events += 25L to request.rowEvent(25, CHAT_PERSONAL, "unarchived")
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/mark-read" -> {
                    readPersonal.set(true)
                    jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                }
                "/api/chat-threads/$CHAT_IN_PROJECT/mark-read" ->
                    MockResponse().setResponseCode(409)
                else -> null
            }
        }
        val inverseWrites = AtomicInteger()
        val deletes = AtomicInteger()
        val releaseDelete = CompletableDeferred<Unit>()
        app.chatService =
            object : WorkspaceSession by fixture.service {
                override suspend fun setArchived(
                    threadId: String,
                    archived: Boolean,
                    eventId: String,
                ) {
                    if (!archived && inverseWrites.incrementAndGet() == 1) {
                        throw ApiFailure.Network(ConnectException("Fixture connection failure"))
                    }
                    fixture.service.setArchived(threadId, archived, eventId)
                }

                override suspend fun deleteProject(projectId: String, eventId: String) {
                    assertEquals(CHAT_PROJECT, projectId)
                    deletes.incrementAndGet()
                    releaseDelete.await()
                    throw ApiFailure.Network(ConnectException("Fixture connection failure"))
                }

                // The fixture owns its transport across Activity configuration changes.
                override fun close() = Unit
            }
        app.connectivity.value = true
        auth.state.value = testAuthenticationState(user = "chat-list-feedback-${UUID.randomUUID()}")

        val failures = mutableListOf<Throwable>()
        val overrideSize = device.overrideValue("wm size")
        val overrideDensity = device.overrideValue("wm density")
        val fontScale = device.executeShellCommand("settings get system font_scale").trim()
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        fun selector(text: String) = By.pkg(app.packageName).text(text)
        fun element(target: BySelector) =
            checkNotNull(device.wait(Until.findObject(target), 10_000)) { "Missing $target" }
        fun text(value: String) = element(selector(value))
        fun text(id: Int) = text(app.getString(id))
        fun openDelete() {
            text(project)
            val node =
                checkNotNull(instrumentation.uiAutomation.rootInActiveWindow.findText(project))
            val row = generateSequence(node) { it.parent }.first { it.isLongClickable }
            assertTrue(row.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK))
            text(R.string.chat_project_delete).click()
            text(R.string.chat_project_delete_title)
            element(By.pkg(app.packageName).textContains(project))
        }

        try {
            val activityScenario = ActivityScenario.launch(MainActivity::class.java)
            scenario = activityScenario
            device.awaitChatList(app)
            text(project)
            text("Personal chat")
            ScreenshotCapture.capture("phone-chat-list.png")
            text("Personal chat").longClick()
            text(R.string.chat_move_project).click()
            text("Operations")
            app.connectivity.value = false
            activityScenario.onActivity { activity ->
                chatJob =
                    checkNotNull(
                            ViewModelProvider(activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready
                        )
                        .chats
                        .viewModelScope
                        .coroutineContext[Job]
            }
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            var offline = false
                            activityScenario.onActivity { activity ->
                                offline =
                                    ViewModelProvider(activity)[SessionModel::class.java]
                                        .uiState
                                        .value
                                        .ready
                                        ?.chats
                                        ?.uiState
                                        ?.value
                                        ?.offline == true
                            }
                            return offline
                        }
                    },
                    10_000,
                )
            )
            assertTrue(text("Operations").isEnabled)
            ScreenshotCapture.capture("offline-move-picker.png")
            assertTrue(device.pressBack())
            text(R.string.chat_list_offline)
            text("Personal chat").longClick()
            text(R.string.chat_archive).click()
            text(R.string.chat_undo_archived)
            val undo = text(R.string.chat_undo)
            assertTrue(undo.isEnabled)
            undo.click()
            text(R.string.chat_undo_connection_failed)
            assertTrue(text(R.string.chat_undo).isEnabled)
            assertEquals(1, inverseWrites.get())
            assertFalse(device.hasObject(selector("Personal chat")))
            ScreenshotCapture.capture("offline-undo.png")

            app.connectivity.value = true
            assertTrue(
                device.wait(Until.gone(selector(app.getString(R.string.chat_list_offline))), 10_000)
            )
            assertEquals(1, inverseWrites.get())
            text(R.string.chat_undo).click()
            text("Personal chat")
            assertTrue(device.wait(Until.gone(selector(app.getString(R.string.chat_undo))), 10_000))
            assertEquals(2, inverseWrites.get())
            ScreenshotCapture.capture("recovered-undo.png")

            val filter = By.pkg(app.packageName).desc(app.getString(R.string.chat_filter))
            element(filter).click()
            text(R.string.chat_unread).click()
            text("Personal chat")
            element(filter).click()
            text(R.string.chat_mark_all_read).click()
            val partialFeedback = app.getString(R.string.chat_mark_all_read_partial, 1, 2)
            text(partialFeedback)
            assertFalse(device.hasObject(selector("Personal chat")))
            text(project)
            ScreenshotCapture.capture("partial-bulk-read.png")
            element(filter).click()
            text(R.string.chat_inbox).click()
            assertTrue(device.wait(Until.gone(selector(partialFeedback)), 10_000))

            text("Personal chat").longClick()
            text(R.string.chat_delete).click()
            text(R.string.chat_delete_title)
            assertTrue(text(R.string.chat_delete_confirm).isEnabled)
            ScreenshotCapture.capture("chat-delete.png")
            text(R.string.settings_cancel).click()

            app.connectivity.value = false
            text(R.string.chat_list_offline)
            openDelete()
            val confirm = text(R.string.chat_project_delete)
            assertTrue(confirm.isEnabled)
            assertEquals(0, deletes.get())
            confirm.click()
            text(R.string.chat_project_delete_pending)
            // The label can be a separate accessibility node from the disabled button.
            val pendingConfirm = text(R.string.chat_project_delete).visibleCenter
            assertTrue(device.click(pendingConfirm.x, pendingConfirm.y))
            device.waitForIdle()
            text(R.string.chat_project_delete_pending)
            assertEquals(1, deletes.get())
            assertTrue(text(R.string.settings_cancel).isEnabled)
            ScreenshotCapture.capture("project-delete-pending.png")
            releaseDelete.complete(Unit)
            text(R.string.chat_action_connection_failed)
            assertTrue(text(R.string.chat_project_delete).isEnabled)
            assertEquals(1, deletes.get())
            ScreenshotCapture.capture("project-delete-offline.png")
            text(R.string.settings_cancel).click()

            device.executeShellCommand("wm size 1000x900")
            device.executeShellCommand("wm density 160")
            device.awaitChatList(app)
            text(R.string.conversation_welcome)
            text("Personal chat")
            ScreenshotCapture.capture("wide-chat-list.png")

            device.executeShellCommand("wm size 320x365")
            device.executeShellCommand("settings put system font_scale 2.0")
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            var compact = false
                            activityScenario.onActivity { activity ->
                                val config = activity.resources.configuration
                                compact = config.fontScale >= 2f && config.screenWidthDp <= 320
                            }
                            return compact
                        }
                    },
                    10_000,
                )
            )
            val list = device.awaitChatList(app)
            if (!device.hasObject(selector(project))) list.swipe(Direction.UP, 0.45f)
            openDelete()
            val compactAction =
                generateSequence(text(R.string.chat_project_delete)) { it.parent }
                    .first { it.isClickable }
            assertTrue(compactAction.isEnabled)
            assertTrue(compactAction.visibleBounds.height() >= 48)
            ScreenshotCapture.capture("compact-project-delete.png")
            text(R.string.settings_cancel).click()
        } catch (error: Throwable) {
            failures += error
            try {
                ScreenshotCapture.capture("failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            releaseDelete.complete(Unit)
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                    { fixture.close() },
                    { savedCache.restore() },
                    { app.restoreApiPreferences(savedPreferences) },
                    { app.chatService = savedService },
                    { app.connectivity.value = savedOnline },
                    { auth.state.value = savedAuth },
                    {
                        if (fontScale.toFloatOrNull() == null)
                            device.executeShellCommand("settings delete system font_scale")
                        else device.executeShellCommand("settings put system font_scale $fontScale")
                        device.executeShellCommand("wm size ${overrideSize ?: "reset"}")
                        device.executeShellCommand("wm density ${overrideDensity ?: "reset"}")
                    },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures += error
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private fun UiDevice.overrideValue(command: String) =
        executeShellCommand(command)
            .lineSequence()
            .firstOrNull { it.startsWith("Override ") }
            ?.substringAfter(": ")
            ?.trim()

    private fun AccessibilityNodeInfo?.findText(value: String): AccessibilityNodeInfo? {
        if (this == null) return null
        if (text?.toString() == value && isVisibleToUser) return this
        for (index in 0 until childCount) {
            getChild(index).findText(value)?.let {
                return it
            }
        }
        return null
    }
}
