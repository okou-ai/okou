"""Tests for body capture text detection and encoding helpers."""

import pytest

from body_capture import _is_text_content


class TestIsTextContent:
    def test_json_with_charset(self):
        assert _is_text_content("application/json; charset=utf-8") is True

    def test_text_html(self):
        assert _is_text_content("text/html") is True

    def test_xml(self):
        assert _is_text_content("application/xml") is True

    def test_form_urlencoded(self):
        assert _is_text_content("application/x-www-form-urlencoded") is True

    def test_empty_assumes_text(self):
        assert _is_text_content("") is True

    def test_graphql(self):
        assert _is_text_content("application/graphql") is True

    @pytest.mark.parametrize(
        "content_type",
        [
            "application/problem+json",
            "application/vnd.api+json; charset=utf-8",
            "Application/Problem+JSON; Charset=UTF-8",
            "application/json-seq",
            "application/x-ndjson",
            "application/" + ("a" * 122) + "+json",
        ],
    )
    def test_json_media_types(self, content_type):
        assert _is_text_content(content_type) is True

    @pytest.mark.parametrize(
        "content_type",
        [
            "application/jsonp",
            "application/problem+jsonx",
            "application/+json",
            "application/*+json",
            "application/problem~+json",
            "application/problem +json",
            "application/problem+json/extra",
            "application/" + ("a" * 123) + "+json",
        ],
    )
    def test_json_media_type_lookalikes(self, content_type):
        assert _is_text_content(content_type) is False
