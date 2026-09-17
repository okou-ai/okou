#!/usr/bin/env python3
"""Exercise AWS response boundaries, delivered evidence and the entry-point guards."""

import contextlib
import copy
import datetime as dt
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import boto3
from botocore.response import StreamingBody
from botocore.stub import Stubber

SCRIPT = Path(__file__).resolve().parents[1] / "aws-audit-target-setup.py"
SPEC = importlib.util.spec_from_file_location("audit_setup", SCRIPT)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)
SECRET = "synthetic-provider-secret-must-not-be-logged"
REQUEST_ID = "8a09df32-b555-47c3-b6a7-5895764899c0"
SNAPSHOT_ID = "07c0eeed-e8d8-48d7-b5f4-922c4798f962"


class AuditSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.session = boto3.Session(
            aws_access_key_id="local-test",
            aws_secret_access_key="local-test",
            region_name=audit.REGION,
        )
        self.clients = {}
        self.stubs = {}
        for service in ["sts", "s3", "iam", "cloudtrail", "config"]:
            client = self.session.client(service)
            stub = Stubber(client)
            stub.activate()
            self.addCleanup(stub.deactivate)
            self.clients[service] = client
            self.stubs[service] = stub
        self.env = {
            "RUNNER_TEMP": str(self.root),
            "GITHUB_REPOSITORY": "vm0-ai/okou",
            "GITHUB_REPOSITORY_ID": "1096175506",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_WORKFLOW_REF": "vm0-ai/okou/.github/workflows/aws-audit-target-setup.yml@refs/heads/main",
            "GITHUB_RUN_ID": "1234",
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://oidc.actions.githubusercontent.com/example",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": SECRET,
        }

    def client(self, service, **_kwargs):
        return self.clients[service]

    def test_iam_trust_allows_only_current_and_renamed_production_subjects(self):
        expected_subjects = [
            "repo:vm0-ai/okou:environment:production",
            "repo:maxandzoe/okou:environment:production",
        ]
        github_directory = SCRIPT.parent.parent
        for relative_path in [
            "aws-audit-32264/operator-trust.json",
            "kms-migration-32264/role-trust.json",
        ]:
            with self.subTest(path=relative_path):
                policy = json.loads((github_directory / relative_path).read_text())
                conditions = policy["Statement"][0]["Condition"]["StringEquals"]
                self.assertEqual(
                    conditions["token.actions.githubusercontent.com:aud"],
                    "sts.amazonaws.com",
                )
                self.assertEqual(
                    conditions["token.actions.githubusercontent.com:sub"],
                    expected_subjects,
                )

    def main(self, account=audit.ACCOUNT, denied=False, oidc_status="200"):
        sts = self.stubs["sts"]
        sts.add_response(
            "assume_role_with_web_identity",
            {
                "Credentials": {
                    "AccessKeyId": "A" * 20,
                    "SecretAccessKey": SECRET,
                    "SessionToken": SECRET,
                    "Expiration": dt.datetime.now(dt.timezone.utc)
                    + dt.timedelta(hours=1),
                }
            },
        )
        sts.add_response(
            "get_caller_identity",
            {
                "Account": account,
                "Arn": f"arn:aws:sts::{account}:assumed-role/vm0-kms-migration-github-32264/github-audit-1234",
                "UserId": "local-test",
            },
        )
        if denied:
            self.stubs["s3"].add_client_error(
                "list_buckets", "AccessDenied", SECRET, 403
            )

        class Session:
            client = self.client

        captured = io.StringIO()
        with (
            patch.dict(os.environ, self.env),
            patch.object(boto3, "client", self.client),
            patch.object(boto3, "Session", return_value=Session()),
            patch.object(
                audit.subprocess,
                "run",
                return_value=SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({"value": SECRET}) + "\n" + oidc_status,
                ),
            ),
            contextlib.redirect_stdout(captured),
        ):
            result = audit.main()
        report_text = (self.root / "aws-audit-target.json").read_text()
        self.assertNotIn(SECRET, captured.getvalue() + report_text)
        return result, json.loads(report_text)

    def test_renamed_repository_reaches_the_same_protected_identity_boundary(self):
        self.env["GITHUB_REPOSITORY"] = "maxandzoe/okou"
        self.env["GITHUB_WORKFLOW_REF"] = (
            "maxandzoe/okou/.github/workflows/"
            "aws-audit-target-setup.yml@refs/heads/main"
        )
        result, report = self.main(account="072707626411")
        self.assertEqual(result, 1)
        self.assertEqual(report["failure"], "wrong_aws_identity")

    def test_wrong_repository_id_stops_before_aws_access(self):
        self.env["GITHUB_REPOSITORY_ID"] = "1"
        result, report = self.main()
        self.assertEqual(result, 1)
        self.assertEqual(report["failure"], "wrong_repository")

    def test_wrong_account_stops_before_resource_changes(self):
        result, report = self.main(account="072707626411")
        self.assertEqual(result, 1)
        self.assertEqual(report["failure"], "wrong_aws_identity")
        self.assertEqual(report["created"], [])
        self.assertFalse(report["configurationApplied"])

    def test_access_denial_is_not_mistaken_for_an_empty_inventory(self):
        result, report = self.main(denied=True)
        self.assertEqual(result, 1)
        self.assertEqual(
            report["failure"], {"operation": "ListBuckets", "code": "AccessDenied"}
        )
        self.assertEqual(report["created"], [])
        self.assertFalse(report["freshDeliveryVerified"])

    def test_pull_request_cannot_reach_production(self):
        self.env["GITHUB_REF"] = "refs/pull/1/merge"
        result, report = self.main()
        self.assertEqual(result, 1)
        self.assertEqual(report["failure"], "main_required")
        self.assertEqual(report["created"], [])

    def test_oidc_redirect_is_rejected_before_aws_access(self):
        result, report = self.main(oidc_status="302")
        self.assertEqual(result, 1)
        self.assertEqual(report["failure"], "oidc_response_rejected")
        self.assertEqual(report["created"], [])

    def test_oidc_token_is_not_sent_to_another_origin(self):
        self.env["ACTIONS_ID_TOKEN_REQUEST_URL"] = "https://example.test/token"
        result, report = self.main()
        self.assertEqual(result, 1)
        self.assertEqual(report["failure"], "unexpected_oidc_url")
        self.assertEqual(report["created"], [])

    def test_existing_trail_bucket_accepts_s3_policy_readback(self):
        settings = audit.expected("cloudtrail-bucket.json")
        policy = copy.deepcopy(settings["policy"])
        # S3 returns this single action as a string, even when written as a list.
        for statement in policy["Statement"]:
            if statement["Sid"] == "AuditServiceBucketCheck":
                statement["Action"] = "s3:GetBucketAcl"
        owner = {"Bucket": audit.TRAIL_BUCKET, "ExpectedBucketOwner": audit.ACCOUNT}
        s3 = self.stubs["s3"]
        s3.add_response("list_buckets", {"Buckets": [{"Name": audit.TRAIL_BUCKET}]})
        responses = [
            ("get_bucket_tagging", {"TagSet": audit.TAGS}),
            (
                "get_bucket_encryption",
                {"ServerSideEncryptionConfiguration": settings["encryption"]},
            ),
            (
                "get_public_access_block",
                {"PublicAccessBlockConfiguration": settings["publicAccess"]},
            ),
            (
                "get_bucket_ownership_controls",
                {"OwnershipControls": settings["ownership"]},
            ),
            ("get_bucket_versioning", {"Status": settings["versioning"]}),
            ("get_bucket_policy", {"Policy": json.dumps(policy)}),
            ("get_bucket_lifecycle_configuration", {"Rules": settings["lifecycle"]}),
            ("get_bucket_location", {"LocationConstraint": audit.REGION}),
            ("get_bucket_policy_status", {"PolicyStatus": {"IsPublic": False}}),
        ]
        for operation, response in responses:
            s3.add_response(operation, response, owner)
        report = {"created": [], "buckets": []}
        audit.configure_bucket(self.clients["s3"], audit.TRAIL_BUCKET, settings, report)
        self.assertEqual(report["created"], [])
        self.assertEqual(report["buckets"][0]["name"], audit.TRAIL_BUCKET)
        self.assertTrue(report["buckets"][0]["verified"])
        s3.assert_no_pending_responses()

    def test_new_trail_matches_multi_region_audit_contract(self):
        desired = {
            "Name": audit.TRAIL,
            "S3BucketName": audit.TRAIL_BUCKET,
            "IncludeGlobalServiceEvents": True,
            "IsMultiRegionTrail": True,
            "LogFileValidationEnabled": True,
            "IsOrganizationTrail": False,
        }
        trail = self.stubs["cloudtrail"]
        trail.add_client_error("get_trail", "TrailNotFoundException", "absent", 400)
        trail.add_response(
            "create_trail",
            {"TrailARN": audit.TRAIL_ARN},
            {
                "Name": audit.TRAIL,
                "S3BucketName": audit.TRAIL_BUCKET,
                "IncludeGlobalServiceEvents": True,
                "IsMultiRegionTrail": True,
                "EnableLogFileValidation": True,
                "IsOrganizationTrail": False,
                "TagsList": audit.TAGS,
            },
        )
        selectors = {
            "EventSelectors": [
                {"ReadWriteType": "All", "IncludeManagementEvents": True}
            ]
        }
        trail.add_response("get_event_selectors", selectors)
        trail.add_response("start_logging", {})
        trail.add_response("get_trail", {"Trail": desired})
        trail.add_response("get_event_selectors", selectors)
        report = {"created": []}
        audit.configure_trail(self.clients["cloudtrail"], report)
        self.assertEqual(report["created"], [audit.TRAIL_ARN])
        trail.assert_no_pending_responses()

    def test_conflicting_existing_trail_is_not_reconfigured(self):
        self.stubs["cloudtrail"].add_response(
            "get_trail",
            {"Trail": {"Name": audit.TRAIL, "S3BucketName": "another-bucket"}},
        )
        report = {"created": []}
        with self.assertRaisesRegex(RuntimeError, "existing_trail_settings_drift"):
            audit.configure_trail(self.clients["cloudtrail"], report)
        self.assertEqual(report["created"], [])

    def delivery_responses(
        self,
        event_request=REQUEST_ID,
        snapshot_account=audit.ACCOUNT,
        include_config_bucket=True,
        item_status="OK",
    ):
        now = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=5)
        trail = self.stubs["cloudtrail"]
        trail.add_response(
            "get_trail_status",
            {"IsLogging": True, "ResponseMetadata": {"RequestId": REQUEST_ID}},
            {"Name": audit.TRAIL_ARN},
        )
        config = self.stubs["config"]
        status = {
            "ConfigurationRecordersStatus": [
                {"name": "default", "recording": True, "lastStatus": "SUCCESS"}
            ]
        }
        config.add_response(
            "describe_configuration_recorder_status",
            status,
            {"ConfigurationRecorderNames": ["default"]},
        )
        config.add_response(
            "list_discovered_resources",
            {
                "resourceIdentifiers": [
                    {"resourceType": "AWS::S3::Bucket", "resourceId": bucket}
                    for bucket in [audit.TRAIL_BUCKET, audit.CONFIG_BUCKET]
                ]
            },
            {
                "resourceType": "AWS::S3::Bucket",
                "resourceIds": [audit.TRAIL_BUCKET, audit.CONFIG_BUCKET],
            },
        )
        config.add_response(
            "deliver_config_snapshot",
            {"configSnapshotId": SNAPSHOT_ID},
            {"deliveryChannelName": "default"},
        )
        trail_key = f"AWSLogs/{audit.ACCOUNT}/CloudTrail/{audit.REGION}/{now:%Y/%m/%d}/new.json.gz"
        config_key = f"AWSLogs/{audit.ACCOUNT}/Config/{audit.REGION}/{now:%Y/%m/%d}/ConfigSnapshot/{audit.ACCOUNT}_Config_{audit.REGION}_ConfigSnapshot_{now:%Y%m%dT%H%M%SZ}_{SNAPSHOT_ID}.json.gz"
        buckets = (
            [audit.TRAIL_BUCKET, audit.CONFIG_BUCKET]
            if include_config_bucket
            else [audit.TRAIL_BUCKET]
        )
        records = {
            "Records": [
                {
                    "requestID": event_request,
                    "eventName": "GetTrailStatus",
                    "recipientAccountId": audit.ACCOUNT,
                    "awsRegion": audit.REGION,
                    "eventTime": now.isoformat(),
                    "privatePayload": SECRET,
                }
            ]
        }
        snapshot = {
            "fileVersion": "1.0",
            "configSnapshotId": SNAPSHOT_ID,
            "configurationItems": [
                {
                    "awsAccountId": snapshot_account,
                    "resourceType": "AWS::S3::Bucket",
                    "resourceId": bucket,
                    "configurationItemStatus": item_status,
                    "configuration": SECRET,
                }
                for bucket in buckets
            ],
        }
        s3 = self.stubs["s3"]
        for bucket, key, data in [
            (audit.TRAIL_BUCKET, trail_key, records),
            (audit.CONFIG_BUCKET, config_key, snapshot),
        ]:
            s3.add_response(
                "list_objects_v2",
                {"Contents": [{"Key": key, "LastModified": now}], "IsTruncated": False},
            )
            body = gzip.compress(json.dumps(data).encode())
            s3.add_response(
                "get_object",
                {"Body": StreamingBody(io.BytesIO(body), len(body))},
                {"Bucket": bucket, "Key": key, "ExpectedBucketOwner": audit.ACCOUNT},
            )
        config.add_response(
            "describe_delivery_channel_status",
            {
                "DeliveryChannelsStatus": [
                    {
                        "name": "default",
                        "configSnapshotDeliveryInfo": {"lastStatus": "SUCCESS"},
                    }
                ]
            },
            {"DeliveryChannelNames": ["default"]},
        )
        config.add_response(
            "describe_configuration_recorder_status",
            status,
            {"ConfigurationRecorderNames": ["default"]},
        )
        trail.add_response(
            "get_trail_status", {"IsLogging": True}, {"Name": audit.TRAIL_ARN}
        )

    def verify(self):
        class Session:
            client = self.client

        report = {}
        audit.verify_delivery(Session(), report, time.monotonic() - 1)
        self.assertNotIn(SECRET, json.dumps(report))
        return report

    def test_actual_matching_event_and_snapshot_complete_delivery_verification(self):
        self.delivery_responses()
        report = self.verify()
        self.assertTrue(report["cloudTrailDelivery"]["verified"])
        self.assertTrue(report["configDelivery"]["auditBucketItemsVerified"])
        self.assertEqual(report["configDelivery"]["configurationItemCount"], 2)

    def test_unrelated_event_cannot_prove_this_runs_delivery(self):
        self.delivery_responses(event_request="different-request")
        with self.assertRaisesRegex(RuntimeError, "fresh_audit_delivery_pending"):
            self.verify()

    def test_snapshot_from_another_account_is_rejected(self):
        self.delivery_responses(snapshot_account="072707626411")
        with self.assertRaisesRegex(RuntimeError, "wrong_config_item_account"):
            self.verify()

    def test_snapshot_must_contain_both_new_audit_buckets(self):
        self.delivery_responses(include_config_bucket=False)
        with self.assertRaisesRegex(
            RuntimeError, "snapshot_missing_audit_bucket_items"
        ):
            self.verify()

    def test_unrecorded_bucket_items_do_not_pass_delivery_verification(self):
        self.delivery_responses(item_status="ResourceNotRecorded")
        with self.assertRaisesRegex(
            RuntimeError, "snapshot_missing_audit_bucket_items"
        ):
            self.verify()


if __name__ == "__main__":
    unittest.main()
