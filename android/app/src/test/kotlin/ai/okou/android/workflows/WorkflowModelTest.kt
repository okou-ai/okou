package ai.okou.android.workflows

import ai.okou.android.CHAT_DATE
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.api.generated.CreateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowRequest
import ai.okou.android.api.generated.WorkflowAutomationVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant1Kind
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant1Type
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.api.generated.WorkflowDetailVisibility
import ai.okou.android.api.generated.WorkflowSummary
import ai.okou.android.api.generated.WorkflowSummaryVisibility
import ai.okou.android.api.generated.WorkspaceWorkflowAutomations
import ai.okou.android.api.generated.WorkspaceWorkflowAutomationsItem
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorkflowModelTest {
    @Test
    fun openingOfflineAttemptsAReadThenResumesOnReconnect() = check { service, model ->
        var reads = 0
        service.catalogRead = {
            reads++
            if (reads == 1) throw ApiFailure.Network(IOException("Offline"))
            listOf(service.summary)
        }
        model.connectivityChanged(true)
        model.visibilityChanged(true)
        runCurrent()

        assertEquals(1, reads)
        assertEquals(WorkflowReadFailure.Offline, model.state.value.catalogFailure)
        assertNull(model.state.value.catalog)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, reads)

        model.connectivityChanged(false)
        runCurrent()
        assertEquals(2, reads)
        assertEquals(listOf(service.summary), model.state.value.catalog)
        assertNull(model.state.value.catalogFailure)
    }

    @Test
    fun reconnectRestartsTheFailedDetailWhileTheCatalogIsStillReadingConnections() =
        check { service, model ->
            val connections = CompletableDeferred<Set<String>>()
            service.connectionsRead = { connections.await() }
            service.detailRead = {
                if (service.detailReads == 1) throw ApiFailure.Network(IOException("Offline"))
                service.detail
            }
            model.connectivityChanged(true)
            model.select(service.summary.id)
            model.visibilityChanged(true)
            runCurrent()
            assertEquals(WorkflowReadFailure.Offline, model.state.value.detailFailure)

            model.connectivityChanged(false)
            runCurrent()
            assertEquals(service.detail, model.state.value.detail)
            assertNull(model.state.value.detailFailure)
            assertNull(model.state.value.connections)
        }

    @Test
    fun cachedReadsBackOffIndependentlyAndOnlyWarnAfterSustainedFailure() =
        check { service, model ->
            model.select(service.summary.id)
            model.visibilityChanged(true)
            runCurrent()
            assertNotNull(model.state.value.catalog)
            assertNotNull(model.state.value.detail)

            val catalogAttempts = mutableListOf<Long>()
            service.catalogRead = {
                catalogAttempts += testScheduler.currentTime
                if (catalogAttempts.size <= 3) throw ApiFailure.Network(IOException("Offline"))
                listOf(service.summary)
            }
            model.visibilityChanged(false)
            model.visibilityChanged(true)
            runCurrent()

            advanceTimeBy(29_999)
            runCurrent()
            assertEquals(listOf(0L, 5_000L, 15_000L), catalogAttempts)
            assertEquals(listOf(service.summary), model.state.value.catalog)
            assertEquals(WorkflowReadFailure.CouldNotLoad, model.state.value.catalogFailure)
            assertNull(model.state.value.detailFailure)
            assertEquals(2, service.detailReads)

            advanceTimeBy(1)
            runCurrent()
            assertEquals(WorkflowReadFailure.RefreshFailed, model.state.value.catalogFailure)
            advanceTimeBy(5_000)
            runCurrent()
            assertEquals(listOf(0L, 5_000L, 15_000L, 35_000L), catalogAttempts)
            assertNull(model.state.value.catalogFailure)
            assertEquals(2, service.detailReads)
        }

    @Test
    fun directoryKeepsConfirmedRulesAfterLeavingDetail() = check { service, model ->
        val rules = CompletableDeferred<WorkspaceWorkflowAutomations>()
        val connections = CompletableDeferred<Set<String>>()
        val active =
            WorkflowAutomationVariant1(
                id = "weekly",
                ownerUserId = service.summary.ownerUserId,
                enabled = true,
                chatThreadId = null,
                nextRunAt = CHAT_DATE,
                lastRunAt = null,
                official = null,
                kind = WorkflowAutomationVariant1Kind.SCHEDULE,
                schedule =
                    WorkflowAutomationVariant1ScheduleVariant1(
                        WorkflowAutomationVariant1ScheduleVariant1Type.CRON,
                        "0 9 * * 1",
                        "UTC",
                    ),
                scheduleSummary = "Weekly at 09:00",
            )
        service.detail = service.detail.copy(automations = listOf(active))
        service.rulesRead = { rules.await() }
        service.connectionsRead = { connections.await() }
        model.visibilityChanged(true)
        runCurrent()
        model.select(service.summary.id)
        runCurrent()
        assertEquals(listOf(active), model.state.value.detail?.automations)
        model.select(null)
        assertNull(model.state.value.detail)

        val paused = active.copy(enabled = false)
        rules.complete(listOf(WorkspaceWorkflowAutomationsItem(service.summary, paused)))
        runCurrent()
        assertNull(model.state.value.connections)
        assertEquals(listOf(active), model.state.value.rules?.get(service.summary.id))

        connections.complete(emptySet())
        runCurrent()
        assertEquals(emptySet<String>(), model.state.value.connections)
        assertEquals(listOf(active), model.state.value.rules?.get(service.summary.id))

        model.select(service.summary.id)
        runCurrent()
        assertEquals(listOf(active), model.state.value.detail?.automations)
        val refreshedDetail = CompletableDeferred<WorkflowDetail>()
        service.detailRead = { refreshedDetail.await() }
        model.connectivityChanged(true)
        model.connectivityChanged(false)
        runCurrent()
        assertEquals(listOf(paused), model.state.value.rules?.get(service.summary.id))
        assertEquals(listOf(paused), model.state.value.detail?.automations)

        refreshedDetail.complete(service.detail.copy(automations = listOf(paused)))
        runCurrent()
        assertEquals(listOf(paused), model.state.value.detail?.automations)
    }

    @Test
    fun directoryKeepsConfirmedSummaryWhenOlderCatalogArrives() = check { service, model ->
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(listOf(service.summary), model.state.value.catalog)

        val catalog = CompletableDeferred<List<WorkflowSummary>>()
        service.catalogRead = { catalog.await() }
        model.connectivityChanged(true)
        model.connectivityChanged(false)
        runCurrent()

        val published =
            service.summary.copy(
                displayName = "Published release review",
                description = "Review the deployment",
                visibility = WorkflowSummaryVisibility.PUBLIC,
            )
        service.detail =
            service.detail.copy(
                displayName = published.displayName,
                description = published.description,
                visibility = WorkflowDetailVisibility.PUBLIC,
            )
        model.select(service.summary.id)
        runCurrent()
        assertEquals(published.displayName, model.state.value.detail?.displayName)
        model.select(null)
        catalog.complete(listOf(service.summary))
        runCurrent()
        assertEquals(listOf(published), model.state.value.catalog)

        model.visibilityChanged(false)
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(listOf(service.summary), model.state.value.catalog)
    }

    @Test
    fun lateCatalogLeavesUnavailableWorkflowRemoved() = check { service, model ->
        val other = service.summary.copy(id = "b2222222-2222-4222-8222-222222222222")
        val previous = listOf(service.summary, other)
        service.catalogRead = { previous }
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(previous, model.state.value.catalog)

        val catalog = CompletableDeferred<List<WorkflowSummary>>()
        service.catalogRead = { catalog.await() }
        model.connectivityChanged(true)
        model.connectivityChanged(false)
        runCurrent()

        service.detailRead = { throw ApiFailure.Http(404, null, null, null) }
        model.select(service.summary.id)
        runCurrent()
        assertEquals(WorkflowReadFailure.Unavailable, model.state.value.detailFailure)
        assertEquals(listOf(other), model.state.value.catalog)
        model.select(null)

        catalog.complete(previous)
        runCurrent()
        assertEquals(listOf(other), model.state.value.catalog)
    }

    @Test
    fun successfulSaveRestartsInterruptedCatalogRead() = check { service, model ->
        var holdCatalog = true
        service.catalogRead = {
            if (holdCatalog) awaitCancellation()
            listOf(service.summary)
        }
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        assertNotNull(model.state.value.detail)
        assertNull(model.state.value.catalog)

        holdCatalog = false
        val opened = checkNotNull(model.state.value.detail).editableInstructions()
        val edited = opened.copy(value = opened.value.copy(instruction = "Confirmed"))
        model.edit(edited)
        model.save(edited)
        runCurrent()

        assertEquals("Confirmed", model.state.value.detail?.instruction)
        assertEquals(listOf(service.summary), model.state.value.catalog)
        assertTrue(model.state.value.rules?.isEmpty() == true)
    }

    @Test
    fun instructionSaveUsesTheCurrentEditor() = check { service, model ->
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        val opened = checkNotNull(model.state.value.detail).editableInstructions()
        val previous = opened.copy(value = opened.value.copy(instruction = "Older edit"))
        val current = opened.copy(value = opened.value.copy(instruction = "Current edit"))
        model.edit(previous)
        model.edit(current)
        model.save(previous)
        runCurrent()

        assertEquals(current, model.state.value.editor)
        assertNull(model.state.value.detail?.instruction)
        model.save(current)
        runCurrent()
        assertEquals("Current edit", model.state.value.detail?.instruction)
        assertNull(model.state.value.editor)
    }

    @Test
    fun uncertainCreationIgnoresAnotherSaveFromTheSameEditor() = check { service, model ->
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        val editor = WorkflowEdit.Rule(id = null, original = RuleFields(timezone = "UTC"))
        model.edit(editor)
        model.connectivityChanged(true)
        model.save(editor)
        runCurrent()

        assertEquals(WorkflowWriteFailure.UncertainCreate, model.state.value.issue?.failure)
        assertEquals(editor, model.state.value.editor)
        model.connectivityChanged(false)
        model.save(editor)
        runCurrent()
        assertEquals(1, service.createAttempts)
    }

    private fun check(action: suspend TestScope.(Service, WorkflowModel) -> Unit) = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val service = Service()
        val store = ViewModelStore()
        val model =
            ViewModelProvider(
                store,
                viewModelFactory {
                    initializer {
                        WorkflowModel(service, { true }, { throw it }) { testScheduler.currentTime }
                    }
                },
            )[WorkflowModel::class.java]
        try {
            action(service, model)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    private class Service : WorkflowService {
        val summary =
            WorkflowSummary(
                id = "a1111111-1111-4111-8111-111111111111",
                name = "release-review",
                displayName = "Release review",
                description = null,
                visibility = WorkflowSummaryVisibility.PRIVATE,
                ownerUserId = "user-a",
                createdAt = CHAT_DATE,
                canManage = true,
                canPublish = true,
                official = null,
                importSource = null,
            )
        var detail =
            WorkflowDetail(
                id = summary.id,
                name = summary.name,
                displayName = summary.displayName,
                description = null,
                visibility = WorkflowDetailVisibility.PRIVATE,
                ownerUserId = summary.ownerUserId,
                createdAt = CHAT_DATE,
                canManage = true,
                canPublish = true,
                official = null,
                importSource = null,
                createdByUserId = summary.ownerUserId,
                updatedByUserId = summary.ownerUserId,
                updatedAt = CHAT_DATE,
                instruction = null,
                files = null,
                fileContents = null,
                automations = emptyList(),
            )
        var catalogRead: suspend () -> List<WorkflowSummary> = { listOf(summary) }
        var detailRead: suspend () -> WorkflowDetail = { detail }
        var rulesRead: suspend () -> WorkspaceWorkflowAutomations = { emptyList() }
        var connectionsRead: suspend () -> Set<String> = { emptySet() }
        var detailReads = 0
            private set

        var createAttempts = 0
            private set

        override suspend fun workflows() = catalogRead()

        override suspend fun workflow(id: String): WorkflowDetail {
            detailReads++
            return detailRead()
        }

        override suspend fun workflowAutomations(): WorkspaceWorkflowAutomations = rulesRead()

        override suspend fun workflowConnections(): Set<String> = connectionsRead()

        override suspend fun updateWorkflow(
            id: String,
            request: UpdateWorkflowRequest,
        ): WorkflowDetail {
            detail =
                detail.copy(instruction = (request.instruction as CanonicalOptional.Present).value)
            return detail
        }

        override suspend fun createAutomation(
            workflowId: String,
            request: CreateWorkflowAutomationRequest,
        ): Nothing {
            createAttempts++
            throw ApiFailure.Network(IOException("Automation response was lost"))
        }

        override suspend fun updateAutomation(
            id: String,
            request: UpdateWorkflowAutomationRequest,
        ) = error("Unexpected automation update")

        override suspend fun setAutomationEnabled(id: String, enabled: Boolean) =
            error("Unexpected automation toggle")
    }
}
