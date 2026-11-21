package ai.okou.android

import ai.okou.android.chat.SearchMessageHit
import ai.okou.android.chat.SearchWorkflowHit
import ai.okou.android.chat.WorkspaceSearchService

internal object EmptyWorkspaceSearchService : WorkspaceSearchService {
    override suspend fun searchMessages(keyword: String) = emptyList<SearchMessageHit>()

    override suspend fun searchableWorkflows() = emptyList<SearchWorkflowHit>()

    override suspend fun searchArtifacts(keyword: String, limit: Int) =
        emptyList<SearchArtifactHit>()
}
