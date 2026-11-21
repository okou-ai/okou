package ai.okou.android.screenshots

import android.util.Base64

// The example avatar thumbnail from the v153 Artifacts design.
internal val releaseAvatarThumbnail =
    Base64.decode(
        """
        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
        L4I/+H+4/gZS0Gz7TIHoCQAAAABJRU5ErkJggg==
    """,
        Base64.DEFAULT,
    )
