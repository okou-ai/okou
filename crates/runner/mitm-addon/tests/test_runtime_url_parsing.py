"""Path compatibility for request-lifetime URL parsing."""

import pytest

from runtime_url_parsing import runtime_url_path


@pytest.mark.parametrize(
    ("value", "path"),
    [
        ("https://api.x.com/2/tweets?ids=1#fragment", "/2/tweets"),
        ("https://api.x.com/2/tweets#fragment?ids=1", "/2/tweets"),
        ("HTTPS://api.x.com/2/tweets;legacy=1?ids=1", "/2/tweets"),
        ("https://api.x.com/2/tweets;legacy=1/123", "/2/tweets;legacy=1/123"),
        ("https://api.x.com/2/tweets;legacy=1/123;tail=1", "/2/tweets;legacy=1/123"),
        ("https://api.x.com/2/tweets%3Blegacy=1", "/2/tweets%3Blegacy=1"),
        ("https://api.x.com/2/%3F/%23?ids=1", "/2/%3F/%23"),
        ("https://api.x.com?ids=1", ""),
        ("/2/tweets;legacy=1?ids=1", "/2/tweets"),
        ("mailto:user;legacy=1?subject=hello", "user;legacy=1"),
        ("custom:/2/tweets;legacy=1?ids=1", "/2/tweets;legacy=1"),
        ("\x00 \r\nhttps://api.x.com/\t2/tweets?ids=1", "/2/tweets"),
    ],
)
def test_runtime_url_path_preserves_urlparse_path_semantics(value, path):
    assert runtime_url_path(value) == path


@pytest.mark.parametrize(
    ("value", "error"),
    [
        ("https://[::1/2/tweets?ids=1", "Invalid IPv6 URL"),
        ("https://api.x.com\uff0f2/tweets?ids=1", "invalid characters under NFKC normalization"),
    ],
)
def test_runtime_url_path_preserves_malformed_authority_rejection(value, error):
    with pytest.raises(ValueError, match=error):
        runtime_url_path(value)
