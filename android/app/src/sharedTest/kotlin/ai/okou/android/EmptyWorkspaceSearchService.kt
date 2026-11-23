package ai.okou.android

import ai.okou.android.chat.SearchArtifactPage
import ai.okou.android.chat.SearchMessageHit
import ai.okou.android.chat.WorkspaceSearchService

internal object EmptyWorkspaceSearchService : WorkspaceSearchService {
    override suspend fun searchMessages(keyword: String) = emptyList<SearchMessageHit>()

    override suspend fun searchArtifacts(keyword: String, cursor: String?) =
        SearchArtifactPage(emptyList(), null)
}
