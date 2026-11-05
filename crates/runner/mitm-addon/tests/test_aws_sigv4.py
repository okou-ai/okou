"""AWS SigV4 signer boundary tests."""

import urllib.parse
from unittest.mock import patch

import pytest

import runtime_url_parsing
from aws_sigv4 import (
    MAX_AWS_SIGV4_QUERY_PAIRS,
    AwsSigV4Credentials,
    AwsSigV4SigningError,
    hash_request_body,
    inspect_request,
    sign_request,
)
from tests.aws_sigv4_helpers import (
    DEFAULT_SIGV4_TIMESTAMP,
    STS_HOST,
    aws_credential_scope,
    aws_sigv4_authorization,
    aws_sigv4_presigned_url,
    signer_test_credentials,
)

_INVALID_UNICODE = "\ud800"
# Header-auth vector: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
# Presigned vector: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html
_AWS_S3_EXAMPLE_HOST = "examplebucket.s3.amazonaws.com"
_AWS_S3_EXAMPLE_TIMESTAMP = "20130524T000000Z"
_AWS_S3_EMPTY_PAYLOAD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
_VALID_BOUNDARY_SIGV4_TIMESTAMP = "20000229T235959Z"
_INVALID_SEMANTIC_SIGV4_TIMESTAMPS = (
    "20261340T256199Z",
    "20260229T000000Z",
    "20261301T000000Z",
    "20260431T000000Z",
    "20260101T240000Z",
    "20260101T236000Z",
    "20260101T235960Z",
)


def _credentials() -> AwsSigV4Credentials:
    return signer_test_credentials()


def _aws_s3_example_credentials() -> AwsSigV4Credentials:
    return AwsSigV4Credentials(
        "AKIAIOSFODNN7EXAMPLE",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    )


def _aws_s3_example_presigned_url() -> str:
    placeholder_scope = urllib.parse.quote(
        "PLACEHOLDER/20130524/us-east-1/s3/aws4_request",
        safe="",
    )
    return (
        f"https://{_AWS_S3_EXAMPLE_HOST}/test.txt"
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256"
        f"&X-Amz-Credential={placeholder_scope}"
        f"&X-Amz-Date={_AWS_S3_EXAMPLE_TIMESTAMP}"
        "&X-Amz-Expires=86400"
        "&X-Amz-SignedHeaders=host"
        "&X-Amz-Signature=placeholder"
    )


def _header_auth_headers(
    amz_date: str = DEFAULT_SIGV4_TIMESTAMP,
    *,
    authorization: str | None = None,
) -> list[tuple[str, str]]:
    return [
        (
            "Authorization",
            (
                aws_sigv4_authorization(date=amz_date[:8])
                if authorization is None
                else authorization
            ),
        ),
        ("X-Amz-Date", amz_date),
        ("Host", STS_HOST),
    ]


def _aws_s3_header_auth_headers(content_hash: str) -> list[tuple[str, str]]:
    return [
        (
            "Authorization",
            aws_sigv4_authorization(
                date="20130524",
                service="s3",
                signed_headers="host;range;x-amz-content-sha256;x-amz-date",
            ),
        ),
        ("Range", "bytes=0-9"),
        ("X-Amz-Content-Sha256", content_hash),
        ("X-Amz-Date", _AWS_S3_EXAMPLE_TIMESTAMP),
        ("Host", _AWS_S3_EXAMPLE_HOST),
    ]


def _header_auth_headers_with_content_hash(value: str) -> list[tuple[str, str]]:
    return [
        (
            "Authorization",
            aws_sigv4_authorization(signed_headers="host;x-amz-content-sha256;x-amz-date"),
        ),
        ("X-Amz-Date", DEFAULT_SIGV4_TIMESTAMP),
        ("X-Amz-Content-Sha256", value),
        ("Host", STS_HOST),
    ]


def _header_auth_headers_with_signed_test_header(value: str) -> list[tuple[str, str]]:
    return [
        (
            "Authorization",
            aws_sigv4_authorization(signed_headers="host;x-amz-date;x-test"),
        ),
        ("X-Amz-Date", DEFAULT_SIGV4_TIMESTAMP),
        ("Host", STS_HOST),
        ("X-Test", value),
    ]


def _presigned_url(
    host: str,
    *,
    timestamp: str = DEFAULT_SIGV4_TIMESTAMP,
) -> str:
    return aws_sigv4_presigned_url(host, date=timestamp[:8], timestamp=timestamp)


def _presigned_url_with_query_pair_count(pair_count: int) -> str:
    base_url = aws_sigv4_presigned_url(STS_HOST, leading_query="")
    base_query = urllib.parse.urlsplit(base_url).query
    base_pair_count = len(base_query.split("&"))
    assert pair_count >= base_pair_count
    leading_query = "&".join(("a=",) * (pair_count - base_pair_count))
    return aws_sigv4_presigned_url(STS_HOST, leading_query=leading_query)


_REJECTED_SIGNING_CONTEXTS = (
    pytest.param(
        _presigned_url(STS_HOST),
        _header_auth_headers(),
        "Ambiguous AWS auth location",
        id="mixed-header-query-auth",
    ),
    pytest.param(
        f"https://{STS_HOST}/",
        _header_auth_headers(authorization=aws_sigv4_authorization(algorithm="AWS4-HMAC-SHA1")),
        "Unsupported AWS signing algorithm",
        id="unsupported-algorithm",
    ),
    pytest.param(
        f"https://{STS_HOST}/",
        _header_auth_headers(authorization=aws_sigv4_authorization(service="s3express")),
        "S3 Express signing is not supported by this runner",
        id="s3express",
    ),
)


@pytest.mark.parametrize(("url", "headers", "error"), _REJECTED_SIGNING_CONTEXTS)
def test_inspect_request_rejects_invalid_signing_context(
    url: str,
    headers: list[tuple[str, str]],
    error: str,
) -> None:
    with pytest.raises(AwsSigV4SigningError, match=error):
        inspect_request(url=url, headers=headers)


@pytest.mark.parametrize(("url", "headers", "error"), _REJECTED_SIGNING_CONTEXTS)
def test_sign_request_rejects_invalid_signing_context(
    url: str,
    headers: list[tuple[str, str]],
    error: str,
) -> None:
    with pytest.raises(AwsSigV4SigningError, match=error):
        sign_request(
            method="GET",
            url=url,
            headers=headers,
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize(
    ("url", "headers", "requires_body"),
    [
        pytest.param(
            f"https://{STS_HOST}/",
            _header_auth_headers(),
            True,
            id="header-body-hash",
        ),
        pytest.param(
            f"https://{STS_HOST}/",
            _header_auth_headers_with_content_hash(_AWS_S3_EMPTY_PAYLOAD_HASH),
            False,
            id="header-explicit-digest",
        ),
        pytest.param(
            f"https://{STS_HOST}/",
            _header_auth_headers_with_content_hash("UNSIGNED-PAYLOAD"),
            False,
            id="header-unsigned",
        ),
        pytest.param(
            _presigned_url(STS_HOST),
            [("Host", STS_HOST)],
            True,
            id="presigned-non-s3",
        ),
        pytest.param(
            aws_sigv4_presigned_url(
                _AWS_S3_EXAMPLE_HOST,
                service="s3",
                date="20130524",
                timestamp=_AWS_S3_EXAMPLE_TIMESTAMP,
            ),
            [("Host", _AWS_S3_EXAMPLE_HOST)],
            False,
            id="presigned-s3",
        ),
    ],
)
def test_inspect_request_reports_payload_semantics(
    url: str,
    headers: list[tuple[str, str]],
    requires_body: bool,
) -> None:
    assert inspect_request(url=url, headers=headers).requires_body is requires_body


@pytest.mark.parametrize(
    ("headers", "error"),
    [
        pytest.param(
            _header_auth_headers_with_content_hash(
                "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
            ),
            "AWS streaming payload signing is not supported",
            id="streaming-payload",
        ),
        pytest.param(
            [
                (
                    "Authorization",
                    aws_sigv4_authorization(
                        algorithm="AWS4-ECDSA-P256-SHA256",
                        region="*",
                    ),
                ),
                ("X-Amz-Date", DEFAULT_SIGV4_TIMESTAMP),
                ("Host", STS_HOST),
            ],
            "SigV4A is not supported",
            id="sigv4a",
        ),
        pytest.param(
            [
                ("Authorization", "malformed"),
                ("X-Amz-Date", DEFAULT_SIGV4_TIMESTAMP),
                ("Host", STS_HOST),
            ],
            "Malformed AWS authorization header",
            id="malformed",
        ),
    ],
)
def test_inspect_request_preserves_signer_errors(
    headers: list[tuple[str, str]],
    error: str,
) -> None:
    with pytest.raises(AwsSigV4SigningError, match=error):
        inspect_request(
            url=f"https://{STS_HOST}/",
            headers=headers,
        )


@pytest.mark.parametrize(
    ("url", "headers"),
    [
        pytest.param(
            "https://sts.amazonaws.com/",
            _header_auth_headers(),
            id="header",
        ),
        pytest.param(
            _presigned_url(STS_HOST),
            [("Host", STS_HOST)],
            id="presigned",
        ),
    ],
)
def test_sign_request_splits_input_url_once(
    url: str,
    headers: list[tuple[str, str]],
) -> None:
    real_urlsplit = runtime_url_parsing._uncached_urlsplit
    with patch.object(
        runtime_url_parsing,
        "_uncached_urlsplit",
        wraps=real_urlsplit,
    ) as urlsplit:
        sign_request(
            method="GET",
            url=url,
            headers=headers,
            body=None,
            credentials=_credentials(),
        )

    urlsplit.assert_called_once_with(url)


def test_sign_request_reuses_matching_inspection_without_changing_output() -> None:
    url = f"https://{STS_HOST}/?Action=GetCallerIdentity"
    headers = _header_auth_headers()
    inspection = inspect_request(url=url, headers=headers)

    real_urlsplit = runtime_url_parsing._uncached_urlsplit
    with patch.object(
        runtime_url_parsing,
        "_uncached_urlsplit",
        wraps=real_urlsplit,
    ) as urlsplit:
        prepared_result = sign_request(
            method="POST",
            url=url,
            headers=headers,
            body=b"request-body",
            credentials=_credentials(),
            inspection=inspection,
        )

    urlsplit.assert_not_called()
    ordinary_result = sign_request(
        method="POST",
        url=url,
        headers=headers,
        body=b"request-body",
        credentials=_credentials(),
    )

    assert prepared_result == ordinary_result


@pytest.mark.parametrize(
    "path",
    [
        pytest.param("/../x", id="leading-parent"),
        pytest.param("/../../x", id="multiple-leading-parents"),
        pytest.param("/a/../../x", id="over-traversal"),
    ],
)
def test_header_auth_leading_dot_segments_use_normalized_canonical_path(path: str) -> None:
    url = f"https://{STS_HOST}{path}"

    signed_url, signed_headers = sign_request(
        method="GET",
        url=url,
        headers=_header_auth_headers(),
        body=None,
        credentials=_credentials(),
    )

    authorization = {name.lower(): value for name, value in signed_headers}["authorization"]
    assert signed_url == url
    assert authorization == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request, "
        "SignedHeaders=host;x-amz-date, "
        "Signature=df6768fccf76887a9d31a01e2d0d48ae57ecdce506e745b20b6ad1960411066b"
    )


def test_header_auth_s3_keeps_dot_segments_in_canonical_path() -> None:
    authorizations: list[str] = []
    for path in ("/../x", "/x"):
        url = f"https://{_AWS_S3_EXAMPLE_HOST}{path}"
        signed_url, signed_headers = sign_request(
            method="GET",
            url=url,
            headers=_aws_s3_header_auth_headers(_AWS_S3_EMPTY_PAYLOAD_HASH),
            body=None,
            credentials=_aws_s3_example_credentials(),
        )

        assert signed_url == url
        authorizations.append(
            {name.lower(): value for name, value in signed_headers}["authorization"]
        )

    assert authorizations[0] != authorizations[1]


@pytest.mark.parametrize(
    ("changed_url", "changed_headers"),
    [
        pytest.param(
            f"https://{STS_HOST}/?Action=GetCallerIdentity&Version=2011-06-15",
            _header_auth_headers(),
            id="query",
        ),
        pytest.param(
            f"https://{STS_HOST}/?Action=GetCallerIdentity",
            _header_auth_headers(
                authorization=aws_sigv4_authorization(service="iam"),
            ),
            id="authorization",
        ),
    ],
)
def test_sign_request_reinspects_changed_representation(
    changed_url: str,
    changed_headers: list[tuple[str, str]],
) -> None:
    original_url = f"https://{STS_HOST}/?Action=GetCallerIdentity"
    original_headers = _header_auth_headers()
    inspection = inspect_request(url=original_url, headers=original_headers)

    prepared_result = sign_request(
        method="POST",
        url=changed_url,
        headers=changed_headers,
        body=b"request-body",
        credentials=_credentials(),
        inspection=inspection,
    )
    ordinary_result = sign_request(
        method="POST",
        url=changed_url,
        headers=changed_headers,
        body=b"request-body",
        credentials=_credentials(),
    )

    assert prepared_result == ordinary_result


def test_presigned_query_preserves_pairs_and_sorts_encoded_values() -> None:
    # %C3%A9 sorts before z after SigV4 URI encoding, opposite the input order.
    url = aws_sigv4_presigned_url(
        STS_HOST,
        leading_query="Tag=z&Tag=%C3%A9&Flag",
    )

    signed_url, _headers = sign_request(
        method="GET",
        url=url,
        headers=[("Host", STS_HOST)],
        body=None,
        credentials=_credentials(),
    )

    query_pairs = urllib.parse.urlsplit(signed_url).query.split("&")
    assert query_pairs[:3] == ["Tag=z", "Tag=%C3%A9", "Flag="]
    assert signed_url == (
        "https://sts.amazonaws.com/?Tag=z&Tag=%C3%A9&Flag="
        "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
        "&X-Amz-Credential=AKIDEXAMPLE%2F20260101%2Fus-east-1%2Fsts%2Faws4_request"
        "&X-Amz-Date=20260101T000000Z"
        "&X-Amz-Expires=60"
        "&X-Amz-SignedHeaders=host"
        "&X-Amz-Signature=468cbb77f2dfadb89e3908770ac79408964deb9deda67950683286d94c4d6730"
    )


@pytest.mark.parametrize(
    ("pair_count", "accepted"),
    [
        (MAX_AWS_SIGV4_QUERY_PAIRS, True),
        (MAX_AWS_SIGV4_QUERY_PAIRS + 1, False),
    ],
    ids=["exact-limit", "over-limit"],
)
def test_query_pair_count_boundary(pair_count: int, accepted: bool) -> None:
    url = _presigned_url_with_query_pair_count(pair_count)
    if not accepted:
        assert "?a=" in url
        # %FF has valid percent syntax but invalid UTF-8, so this also proves
        # the pair-count preflight runs before query-component decoding.
        url = url.replace("?a=", "?invalid=%FF", 1)
    parts = urllib.parse.urlsplit(url)
    assert len(f"{parts.path}?{parts.query}".encode()) < 64 * 1024
    headers = [("Host", STS_HOST)]

    if accepted:
        inspection = inspect_request(url=url, headers=headers)
        signed_url, _signed_headers = sign_request(
            method="GET",
            url=url,
            headers=headers,
            body=None,
            credentials=_credentials(),
            inspection=inspection,
        )
        signed_query = urllib.parse.urlsplit(signed_url).query
        assert len(signed_query.split("&")) == MAX_AWS_SIGV4_QUERY_PAIRS
        return

    with pytest.raises(
        AwsSigV4SigningError,
        match=r"^AWS request has too many query parameters$",
    ):
        inspect_request(url=url, headers=headers)
    with pytest.raises(
        AwsSigV4SigningError,
        match=r"^AWS request has too many query parameters$",
    ):
        sign_request(
            method="GET",
            url=url,
            headers=headers,
            body=None,
            credentials=_credentials(),
        )


def test_query_pair_count_ignores_empty_segments() -> None:
    url = aws_sigv4_presigned_url(
        STS_HOST,
        leading_query="&" * (MAX_AWS_SIGV4_QUERY_PAIRS + 1),
    )
    raw_query = urllib.parse.urlsplit(url).query
    assert raw_query.count("&") > MAX_AWS_SIGV4_QUERY_PAIRS

    inspection = inspect_request(url=url, headers=[("Host", STS_HOST)])
    assert inspection.requires_body is True


@pytest.mark.parametrize(
    ("url", "headers"),
    [
        pytest.param(
            f"https://{STS_HOST}/",
            _header_auth_headers(),
            id="header",
        ),
        pytest.param(
            _presigned_url(STS_HOST),
            [("Host", STS_HOST)],
            id="presigned",
        ),
    ],
)
def test_precomputed_body_hash_matches_direct_body_signing(
    url: str,
    headers: list[tuple[str, str]],
) -> None:
    body = b"expected body"
    expected = sign_request(
        method="POST",
        url=url,
        headers=headers,
        body=body,
        credentials=_credentials(),
    )

    actual = sign_request(
        method="POST",
        url=url,
        headers=headers,
        body=b"body ignored by the precomputed path",
        credentials=_credentials(),
        precomputed_body_hash=hash_request_body(body),
    )

    assert actual == expected


@pytest.mark.parametrize("amz_date", _INVALID_SEMANTIC_SIGV4_TIMESTAMPS)
def test_header_auth_impossible_amz_date_raises_signing_error(amz_date: str) -> None:
    with pytest.raises(AwsSigV4SigningError, match=r"^Malformed AWS signing date$"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=_header_auth_headers(amz_date),
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize("amz_date", _INVALID_SEMANTIC_SIGV4_TIMESTAMPS)
def test_presigned_query_impossible_amz_date_raises_signing_error(amz_date: str) -> None:
    with pytest.raises(AwsSigV4SigningError, match=r"^Malformed AWS signing date$"):
        sign_request(
            method="GET",
            url=_presigned_url("sts.amazonaws.com", timestamp=amz_date),
            headers=[("Host", "sts.amazonaws.com")],
            body=None,
            credentials=_credentials(),
        )


def test_header_auth_valid_boundary_amz_date_signs() -> None:
    _url, headers = sign_request(
        method="GET",
        url="https://sts.amazonaws.com/",
        headers=_header_auth_headers(_VALID_BOUNDARY_SIGV4_TIMESTAMP),
        body=None,
        credentials=_credentials(),
    )

    authorization = {name.lower(): value for name, value in headers}["authorization"]
    assert "Credential=AKIDEXAMPLE/20000229/us-east-1/sts/aws4_request" in authorization


def test_presigned_query_valid_boundary_amz_date_signs() -> None:
    signed_url, _headers = sign_request(
        method="GET",
        url=_presigned_url(
            "sts.amazonaws.com",
            timestamp=_VALID_BOUNDARY_SIGV4_TIMESTAMP,
        ),
        headers=[("Host", "sts.amazonaws.com")],
        body=None,
        credentials=_credentials(),
    )

    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(signed_url).query))
    assert query["X-Amz-Date"] == _VALID_BOUNDARY_SIGV4_TIMESTAMP
    assert query["X-Amz-Credential"] == "AKIDEXAMPLE/20000229/us-east-1/sts/aws4_request"


def test_header_auth_malformed_url_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url="https://[::1",
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


def test_header_auth_invalid_bracketed_host_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url="https://[foo]/",
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


def test_presigned_query_malformed_url_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=_presigned_url("[::1"),
            headers=[("Host", "sts.amazonaws.com")],
            body=None,
            credentials=_credentials(),
        )


def test_presigned_query_double_encoded_credential_raises_signing_error() -> None:
    double_encoded_credential = urllib.parse.quote(
        urllib.parse.quote(aws_credential_scope(), safe=""),
        safe="",
    )
    url = (
        "https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15"
        "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
        f"&X-Amz-Credential={double_encoded_credential}"
        "&X-Amz-Date=20260101T000000Z"
        "&X-Amz-Expires=60"
        "&X-Amz-SignedHeaders=host"
        "&X-Amz-Signature=placeholder"
    )

    with pytest.raises(AwsSigV4SigningError, match="Malformed AWS credential scope"):
        sign_request(
            method="GET",
            url=url,
            headers=[("Host", "sts.amazonaws.com")],
            body=None,
            credentials=_credentials(),
        )


def test_presigned_query_invalid_bracketed_host_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=_presigned_url("[foo]"),
            headers=[("Host", "sts.amazonaws.com")],
            body=None,
            credentials=_credentials(),
        )


def test_header_auth_percent_encoded_credential_raises_signing_error() -> None:
    headers = [
        (
            "Authorization",
            "AWS4-HMAC-SHA256 "
            "Credential=PLACEHOLDER%2F20260101%2Fus-east-1%2Fsts%2Faws4_request, "
            "SignedHeaders=host;x-amz-date, "
            "Signature=placeholder",
        ),
        ("X-Amz-Date", "20260101T000000Z"),
        ("Host", "sts.amazonaws.com"),
    ]

    with pytest.raises(AwsSigV4SigningError, match="Malformed AWS credential scope"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=headers,
            body=None,
            credentials=_credentials(),
        )


def test_header_auth_invalid_unicode_path_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=f"https://sts.amazonaws.com/{_INVALID_UNICODE}",
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize("path", ["/%ZZ", "/%"])
def test_header_auth_malformed_percent_encoded_path_raises_signing_error(
    path: str,
) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=f"https://sts.amazonaws.com{path}",
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize(
    "url",
    [
        "https://sts.amazonaws.com/pa\nth",
        " https://sts.amazonaws.com/path",
    ],
)
def test_header_auth_raw_whitespace_url_raises_signing_error(url: str) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=url,
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


def test_presigned_query_invalid_unicode_query_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=f"{_presigned_url('sts.amazonaws.com')}&Extra={_INVALID_UNICODE}",
            headers=[("Host", "sts.amazonaws.com")],
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize("query", ["Bad=%ED%A0%80", "Bad=%ZZ"])
def test_presigned_query_malformed_percent_encoding_raises_signing_error(
    query: str,
) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=f"{_presigned_url('sts.amazonaws.com')}&{query}",
            headers=[("Host", "sts.amazonaws.com")],
            body=None,
            credentials=_credentials(),
        )


def test_header_auth_invalid_unicode_fragment_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL is malformed"):
        sign_request(
            method="GET",
            url=f"https://sts.amazonaws.com/#fragment{_INVALID_UNICODE}",
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


def test_signed_header_invalid_unicode_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request header contains invalid text"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=[*_header_auth_headers(), ("x-amz-meta-test", _INVALID_UNICODE)],
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize("header_value", ["a\n b", "a\r b", "a\x00b", "a\x7fb"])
def test_signed_header_control_character_raises_signing_error(header_value: str) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request header contains invalid text"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=_header_auth_headers_with_signed_test_header(header_value),
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize(
    "header",
    [
        (f"x-other-{_INVALID_UNICODE}", "value"),
        ("x-other", f"value{_INVALID_UNICODE}"),
    ],
)
def test_unsigned_header_invalid_unicode_raises_signing_error(
    header: tuple[str, str],
) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request header contains invalid text"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=[*_header_auth_headers(), header],
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize("header_value", ["a\n b", "a\r b", "a\x00b", "a\x7fb"])
def test_unsigned_header_control_character_raises_signing_error(header_value: str) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request header contains invalid text"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=[*_header_auth_headers(), ("x-other", header_value)],
            body=None,
            credentials=_credentials(),
        )


def test_presigned_query_unsigned_header_control_character_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request header contains invalid text"):
        sign_request(
            method="GET",
            url=_presigned_url("sts.amazonaws.com"),
            headers=[("Host", "sts.amazonaws.com"), ("x-other", "a\n b")],
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize("header_name", ["", "x other", "x:other", "x\nother", "x\x00other"])
def test_header_invalid_name_raises_signing_error(header_name: str) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request header contains invalid text"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=[*_header_auth_headers(), (header_name, "value")],
            body=None,
            credentials=_credentials(),
        )


def test_signed_header_tab_value_signs() -> None:
    _url, headers = sign_request(
        method="GET",
        url="https://sts.amazonaws.com/",
        headers=_header_auth_headers_with_signed_test_header("a\t b"),
        body=None,
        credentials=_credentials(),
    )

    by_name = {name.lower(): value for name, value in headers}
    assert by_name["x-test"] == "a\t b"
    assert "SignedHeaders=host;x-amz-date;x-test" in by_name["authorization"]


def test_invalid_unicode_secret_key_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="Invalid AWS secret access key"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com/",
            headers=_header_auth_headers(),
            body=None,
            credentials=AwsSigV4Credentials("AKIDEXAMPLE", f"secret{_INVALID_UNICODE}"),
        )


def test_invalid_port_keeps_specific_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS request URL has an invalid port"):
        sign_request(
            method="GET",
            url="https://sts.amazonaws.com:bad/",
            headers=_header_auth_headers(),
            body=None,
            credentials=_credentials(),
        )


@pytest.mark.parametrize("header_value", ["", " \t  "])
def test_header_auth_empty_content_hash_header_raises_signing_error(
    header_value: str,
) -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS content hash header is empty"):
        sign_request(
            method="POST",
            url="https://sts.amazonaws.com/",
            headers=_header_auth_headers_with_content_hash(header_value),
            body=b"hello",
            credentials=_credentials(),
        )


@pytest.mark.parametrize("header_value", ["placeholder-hash", "A" * 64])
def test_header_auth_invalid_content_hash_header_raises_signing_error(
    header_value: str,
) -> None:
    with pytest.raises(AwsSigV4SigningError, match="Unsupported AWS content hash header"):
        sign_request(
            method="POST",
            url="https://sts.amazonaws.com/",
            headers=_header_auth_headers_with_content_hash(header_value),
            body=b"hello",
            credentials=_credentials(),
        )


@pytest.mark.parametrize(
    "header_value",
    [
        "a" * 64 + "\n",
        "UNSIGNED-PAYLOAD\r",
        "a" * 64 + "\u00a0",
        "\uff41" * 64,
    ],
)
def test_header_auth_non_ascii_or_control_content_hash_header_raises_signing_error(
    header_value: str,
) -> None:
    with pytest.raises(
        AwsSigV4SigningError,
        match="AWS content hash header contains invalid text",
    ):
        sign_request(
            method="POST",
            url="https://sts.amazonaws.com/",
            headers=_header_auth_headers_with_content_hash(header_value),
            body=b"hello",
            credentials=_credentials(),
        )


def test_header_auth_streaming_content_hash_header_raises_signing_error() -> None:
    with pytest.raises(
        AwsSigV4SigningError,
        match="AWS streaming payload signing is not supported",
    ):
        sign_request(
            method="POST",
            url="https://sts.amazonaws.com/",
            headers=_header_auth_headers_with_content_hash(
                "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
            ),
            body=b"hello",
            credentials=_credentials(),
        )


@pytest.mark.parametrize(
    "header_value",
    [_AWS_S3_EMPTY_PAYLOAD_HASH, f" \t{_AWS_S3_EMPTY_PAYLOAD_HASH}\t "],
)
@pytest.mark.parametrize(
    "body",
    [None, b"different body"],
    ids=["reference-body", "different-body"],
)
def test_header_auth_content_hash_controls_aws_reference_signature(
    header_value: str,
    body: bytes | None,
) -> None:
    _url, headers = sign_request(
        method="GET",
        url=f"https://{_AWS_S3_EXAMPLE_HOST}/test.txt",
        headers=_aws_s3_header_auth_headers(header_value),
        body=body,
        credentials=_aws_s3_example_credentials(),
        precomputed_body_hash=hash_request_body(b"ignored precomputed body"),
    )

    authorization = {name.lower(): value for name, value in headers}["authorization"]
    assert authorization == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    )


@pytest.mark.parametrize("header_value", ["UNSIGNED-PAYLOAD", " \tUNSIGNED-PAYLOAD\t "])
@pytest.mark.parametrize("body", [b"first body", b"different body"])
def test_header_auth_unsigned_payload_controls_reference_signature(
    header_value: str,
    body: bytes,
) -> None:
    _url, headers = sign_request(
        method="GET",
        url=f"https://{_AWS_S3_EXAMPLE_HOST}/test.txt",
        headers=_aws_s3_header_auth_headers(header_value),
        body=body,
        credentials=_aws_s3_example_credentials(),
        precomputed_body_hash=hash_request_body(b"ignored precomputed body"),
    )

    authorization = {name.lower(): value for name, value in headers}["authorization"]
    assert authorization == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=edacce68e5445863e1f916719fac26d3be9c1581fccd7878ade0879597fc0dc1"
    )


def test_presigned_s3_unsigned_payload_matches_aws_reference_signature() -> None:
    signed_url, _headers = sign_request(
        method="GET",
        url=_aws_s3_example_presigned_url(),
        headers=[("Host", _AWS_S3_EXAMPLE_HOST)],
        body=None,
        credentials=_aws_s3_example_credentials(),
        precomputed_body_hash=hash_request_body(b"ignored precomputed body"),
    )

    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(signed_url).query))
    assert (
        query["X-Amz-Signature"]
        == "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    )


def test_presigned_s3_content_hash_controls_signature() -> None:
    signatures: list[str] = []
    for content_hash in ("a" * 64, "b" * 64):
        signed_url, _headers = sign_request(
            method="GET",
            url=_aws_s3_example_presigned_url(),
            headers=[
                ("Host", _AWS_S3_EXAMPLE_HOST),
                ("X-Amz-Content-Sha256", content_hash),
            ],
            body=b"same body",
            credentials=_aws_s3_example_credentials(),
            precomputed_body_hash=hash_request_body(b"ignored precomputed body"),
        )

        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(signed_url).query))
        assert query["X-Amz-SignedHeaders"] == "host"
        signatures.append(query["X-Amz-Signature"])

    assert signatures[0] != signatures[1]


def test_presigned_query_invalid_content_hash_header_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="Unsupported AWS content hash header"):
        sign_request(
            method="GET",
            url=_presigned_url("sts.amazonaws.com"),
            headers=[
                ("Host", "sts.amazonaws.com"),
                ("X-Amz-Content-Sha256", "placeholder-hash"),
            ],
            body=None,
            credentials=_credentials(),
        )


def test_presigned_query_empty_content_hash_header_raises_signing_error() -> None:
    with pytest.raises(AwsSigV4SigningError, match="AWS content hash header is empty"):
        sign_request(
            method="GET",
            url=_presigned_url("sts.amazonaws.com"),
            headers=[
                ("Host", "sts.amazonaws.com"),
                ("X-Amz-Content-Sha256", ""),
            ],
            body=None,
            credentials=_credentials(),
        )
