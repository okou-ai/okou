#!/usr/bin/env python3
"""Configure only the #32264 target audit resources; retain sanitized evidence."""

import datetime as dt
import gzip
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse

import boto3
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import ClientError

ACCOUNT = "251964670836"
REGION = "us-west-2"
TRAIL = "vm0-drata-cloudtrail"
TRAIL_ARN = f"arn:aws:cloudtrail:{REGION}:{ACCOUNT}:trail/{TRAIL}"
TRAIL_BUCKET = f"vm0-cloudtrail-logs-{ACCOUNT}-{REGION}"
CONFIG_BUCKET = f"vm0-dcf478-aws-config-{ACCOUNT}-{REGION}"
CONFIG_ROLE = "vm0-dcf478-config-recorder-role"
CONFIG_ROLE_ARN = f"arn:aws:iam::{ACCOUNT}:role/{CONFIG_ROLE}"
OPERATOR = f"arn:aws:iam::{ACCOUNT}:role/vm0-kms-migration-github-32264"
MANAGED_POLICY = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
TAGS = [{"Key": "ManagedBy", "Value": "vm0-audit-32264"}]
DIRECTORY = Path(__file__).resolve().parents[1] / "aws-audit-32264"
SDK_CONFIG = Config(retries={"mode": "standard", "max_attempts": 3}, read_timeout=30)
MAX_OBJECT_BYTES = 20 * 1024 * 1024
# GitHub keeps this numeric identity stable across owner and repository renames.
OKOU_REPOSITORY_ID = "1096175506"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def expected(name):
    return json.loads((DIRECTORY / name).read_text())


def optional(operation, missing_code, **parameters):
    try:
        return operation(**parameters)
    except ClientError as error:
        if error.response["Error"]["Code"] == missing_code:
            return None
        raise


def create_after_policy_propagation(operation, **parameters):
    deadline = time.monotonic() + 120
    while True:
        try:
            return operation(**parameters)
        except ClientError as error:
            if (
                error.response["Error"]["Code"]
                not in {
                    "InvalidRoleException",
                    "InsufficientDeliveryPolicyException",
                    "InsufficientS3BucketPolicyException",
                }
                or time.monotonic() >= deadline
            ):
                raise
            print(json.dumps({"waiting": "new_audit_policy_propagation"}), flush=True)
            time.sleep(10)


def workflow_identity():
    repository = os.environ.get("GITHUB_REPOSITORY")
    require(
        os.environ.get("GITHUB_REPOSITORY_ID") == OKOU_REPOSITORY_ID,
        "wrong_repository",
    )
    require(bool(repository), "wrong_repository")
    require(os.environ.get("GITHUB_REF") == "refs/heads/main", "main_required")
    require(
        os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch",
        "manual_run_required",
    )
    require(
        os.environ.get("GITHUB_WORKFLOW_REF")
        == f"{repository}/.github/workflows/aws-audit-target-setup.yml@refs/heads/main",
        "wrong_workflow",
    )
    request_url = urllib.parse.urlsplit(os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"])
    require(
        request_url.scheme == "https"
        and request_url.hostname is not None
        and request_url.hostname.endswith(".actions.githubusercontent.com")
        and request_url.port in {None, 443}
        and request_url.username is None
        and request_url.password is None
        and not request_url.fragment,
        "unexpected_oidc_url",
    )
    query = urllib.parse.parse_qsl(request_url.query)
    query = [(key, value) for key, value in query if key != "audience"]
    query.append(("audience", "sts.amazonaws.com"))
    # Curl does not follow redirects here. Only the validated GitHub HTTPS origin
    # can receive the job's request token; response bodies and errors stay private.
    response = subprocess.run(
        [
            "curl",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--max-time",
            "30",
            "--max-filesize",
            "1048576",
            "--header",
            "Authorization: Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"],
            "--write-out",
            "\n%{http_code}",
            urllib.parse.urlunsplit(
                request_url._replace(query=urllib.parse.urlencode(query))
            ),
        ],
        text=True,
        capture_output=True,
        timeout=35,
        check=False,
    )
    require(response.returncode == 0, "oidc_request_failed")
    body, status = response.stdout.rsplit("\n", 1)
    require(status == "200" and len(body) <= 1048576, "oidc_response_rejected")
    token = json.loads(body)["value"]
    session_name = "github-audit-" + os.environ["GITHUB_RUN_ID"]
    response = boto3.client(
        "sts", region_name=REGION, config=Config(signature_version=UNSIGNED)
    ).assume_role_with_web_identity(
        RoleArn=OPERATOR,
        RoleSessionName=session_name,
        WebIdentityToken=token,
        DurationSeconds=3600,
    )
    credentials = response["Credentials"]
    session = boto3.Session(
        aws_access_key_id=credentials["AccessKeyId"],
        aws_secret_access_key=credentials["SecretAccessKey"],
        aws_session_token=credentials["SessionToken"],
        region_name=REGION,
    )
    identity = session.client("sts", config=SDK_CONFIG).get_caller_identity()
    require(
        identity["Account"] == ACCOUNT
        and identity["Arn"]
        == f"arn:aws:sts::{ACCOUNT}:assumed-role/vm0-kms-migration-github-32264/{session_name}",
        "wrong_aws_identity",
    )
    return session


def bucket_settings(s3, bucket):
    owner = {"Bucket": bucket, "ExpectedBucketOwner": ACCOUNT}
    encryption = s3.get_bucket_encryption(**owner)["ServerSideEncryptionConfiguration"]
    for rule in encryption["Rules"]:
        # S3 can explicitly return this default even for SSE-S3 buckets.
        if rule.get("BucketKeyEnabled") is False:
            del rule["BucketKeyEnabled"]
    return {
        "encryption": encryption,
        "publicAccess": s3.get_public_access_block(**owner)[
            "PublicAccessBlockConfiguration"
        ],
        "ownership": s3.get_bucket_ownership_controls(**owner)["OwnershipControls"],
        "versioning": s3.get_bucket_versioning(**owner).get("Status"),
        "policy": json.loads(s3.get_bucket_policy(**owner)["Policy"]),
        "lifecycle": s3.get_bucket_lifecycle_configuration(**owner)["Rules"],
    }


def configure_bucket(s3, bucket, settings, report):
    existing = {
        entry["Name"]
        for page in s3.get_paginator("list_buckets").paginate()
        for entry in page["Buckets"]
    }
    owner = {"Bucket": bucket, "ExpectedBucketOwner": ACCOUNT}
    if bucket in existing:
        require(
            s3.get_bucket_tagging(**owner)["TagSet"] == TAGS,
            "existing_bucket_ownership_mismatch",
        )
        # Existing settings must match; a rerun cannot silently erase policy changes.
        require(
            bucket_settings(s3, bucket) == settings, "existing_bucket_settings_drift"
        )
    else:
        s3.create_bucket(
            Bucket=bucket,
            CreateBucketConfiguration={"LocationConstraint": REGION},
            ObjectOwnership="BucketOwnerEnforced",
        )
        report["created"].append(bucket)
        s3.put_bucket_tagging(**owner, Tagging={"TagSet": TAGS})
        s3.put_public_access_block(
            **owner, PublicAccessBlockConfiguration=settings["publicAccess"]
        )
        s3.put_bucket_encryption(
            **owner, ServerSideEncryptionConfiguration=settings["encryption"]
        )
        s3.put_bucket_versioning(
            **owner, VersioningConfiguration={"Status": settings["versioning"]}
        )
        s3.put_bucket_policy(**owner, Policy=json.dumps(settings["policy"]))
        s3.put_bucket_lifecycle_configuration(
            **owner, LifecycleConfiguration={"Rules": settings["lifecycle"]}
        )
        require(
            bucket_settings(s3, bucket) == settings, "bucket_settings_readback_mismatch"
        )
    require(
        s3.get_bucket_location(**owner)["LocationConstraint"] == REGION,
        "wrong_bucket_region",
    )
    require(
        s3.get_bucket_policy_status(**owner)["PolicyStatus"]["IsPublic"] is False,
        "public_bucket",
    )
    report["buckets"].append(
        {
            "name": bucket,
            "verified": True,
            "encryption": "AES256",
            "versioning": "Enabled",
            "automaticLogExpiration": False,
        }
    )


def configure_role(iam, report):
    trust = expected("config-trust.json")
    policy = expected("config-delivery-policy.json")
    existing = optional(iam.get_role, "NoSuchEntity", RoleName=CONFIG_ROLE)
    if existing is None:
        iam.create_role(
            RoleName=CONFIG_ROLE, AssumeRolePolicyDocument=json.dumps(trust), Tags=TAGS
        )
        report["created"].append(CONFIG_ROLE_ARN)
    else:
        require(existing["Role"]["Arn"] == CONFIG_ROLE_ARN, "wrong_config_role")
        require(
            existing["Role"]["AssumeRolePolicyDocument"] == trust,
            "config_role_trust_drift",
        )
        require(existing["Role"].get("Tags") == TAGS, "config_role_ownership_mismatch")
        require(
            "PermissionsBoundary" not in existing["Role"],
            "unexpected_config_role_boundary",
        )
    attached = {
        entry["PolicyArn"]
        for page in iam.get_paginator("list_attached_role_policies").paginate(
            RoleName=CONFIG_ROLE
        )
        for entry in page["AttachedPolicies"]
    }
    require(
        attached.issubset({MANAGED_POLICY}), "unexpected_config_role_managed_policy"
    )
    if not attached:
        iam.attach_role_policy(RoleName=CONFIG_ROLE, PolicyArn=MANAGED_POLICY)
    names = {
        name
        for page in iam.get_paginator("list_role_policies").paginate(
            RoleName=CONFIG_ROLE
        )
        for name in page["PolicyNames"]
    }
    require(
        names.issubset({"audit-delivery-32264"}), "unexpected_config_role_inline_policy"
    )
    if names:
        require(
            iam.get_role_policy(
                RoleName=CONFIG_ROLE, PolicyName="audit-delivery-32264"
            )["PolicyDocument"]
            == policy,
            "config_role_policy_drift",
        )
    else:
        iam.put_role_policy(
            RoleName=CONFIG_ROLE,
            PolicyName="audit-delivery-32264",
            PolicyDocument=json.dumps(policy),
        )
    require(
        iam.get_role(RoleName=CONFIG_ROLE)["Role"]["AssumeRolePolicyDocument"] == trust,
        "config_role_trust_readback_mismatch",
    )
    require(
        iam.get_role_policy(RoleName=CONFIG_ROLE, PolicyName="audit-delivery-32264")[
            "PolicyDocument"
        ]
        == policy,
        "config_role_policy_readback_mismatch",
    )


def configure_trail(trail, report):
    desired = {
        "Name": TRAIL,
        "S3BucketName": TRAIL_BUCKET,
        "IncludeGlobalServiceEvents": True,
        "IsMultiRegionTrail": True,
        "LogFileValidationEnabled": True,
        "IsOrganizationTrail": False,
    }
    existing = optional(trail.get_trail, "TrailNotFoundException", Name=TRAIL_ARN)
    if existing is None:
        parameters = {
            k: v for k, v in desired.items() if k != "LogFileValidationEnabled"
        }
        create_after_policy_propagation(
            trail.create_trail,
            **parameters,
            EnableLogFileValidation=True,
            TagsList=TAGS,
        )
        report["created"].append(TRAIL_ARN)
    else:
        require(
            all(existing["Trail"].get(k) == v for k, v in desired.items()),
            "existing_trail_settings_drift",
        )
        require(
            not existing["Trail"].get("KmsKeyId")
            and not existing["Trail"].get("S3KeyPrefix"),
            "unexpected_trail_destination",
        )
    selectors = [
        {
            "ReadWriteType": "All",
            "IncludeManagementEvents": True,
            "DataResources": [],
            "ExcludeManagementEventSources": [],
        }
    ]
    current = trail.get_event_selectors(TrailName=TRAIL_ARN)
    require(
        not current.get("AdvancedEventSelectors"), "unexpected_advanced_event_selectors"
    )

    def normalize_selectors(values):
        return [
            {
                "ReadWriteType": value["ReadWriteType"],
                "IncludeManagementEvents": value["IncludeManagementEvents"],
                "DataResources": value.get("DataResources", []),
                "ExcludeManagementEventSources": value.get(
                    "ExcludeManagementEventSources", []
                ),
            }
            for value in values
        ]

    if normalize_selectors(current["EventSelectors"]) != selectors:
        require(existing is None, "existing_trail_event_selector_drift")
        trail.put_event_selectors(TrailName=TRAIL_ARN, EventSelectors=selectors)
    trail.start_logging(Name=TRAIL_ARN)
    actual = trail.get_trail(Name=TRAIL_ARN)["Trail"]
    require(
        all(actual.get(k) == v for k, v in desired.items()), "trail_readback_mismatch"
    )
    require(
        normalize_selectors(
            trail.get_event_selectors(TrailName=TRAIL_ARN)["EventSelectors"]
        )
        == selectors,
        "trail_event_selector_readback_mismatch",
    )


def configure_config(config, report):
    recorder = {
        "name": "default",
        "roleARN": CONFIG_ROLE_ARN,
        "recordingGroup": {
            "allSupported": True,
            "includeGlobalResourceTypes": True,
            "recordingStrategy": {"useOnly": "ALL_SUPPORTED_RESOURCE_TYPES"},
        },
        "recordingMode": {"recordingFrequency": "CONTINUOUS"},
    }
    existing = config.describe_configuration_recorders()["ConfigurationRecorders"]
    require(len(existing) <= 1, "unexpected_config_recorders")
    if existing:
        actual = existing[0]
        require(
            actual["name"] == "default" and actual["roleARN"] == CONFIG_ROLE_ARN,
            "existing_config_recorder_mismatch",
        )
        require(
            actual["recordingGroup"]["allSupported"] is True
            and actual["recordingGroup"]["includeGlobalResourceTypes"] is True,
            "existing_config_recording_scope_drift",
        )
        require(
            actual["recordingGroup"].get("recordingStrategy", {}).get("useOnly")
            == "ALL_SUPPORTED_RESOURCE_TYPES"
            and not actual["recordingGroup"]
            .get("exclusionByResourceTypes", {})
            .get("resourceTypes")
            and not actual["recordingGroup"].get("resourceTypes"),
            "existing_config_resource_exclusions",
        )
        require(
            actual["recordingMode"]["recordingFrequency"] == "CONTINUOUS"
            and not actual["recordingMode"].get("recordingModeOverrides"),
            "existing_config_recording_mode_drift",
        )
    else:
        create_after_policy_propagation(
            config.put_configuration_recorder, ConfigurationRecorder=recorder
        )
        report["created"].append("config:default-recorder")
    channel = {
        "name": "default",
        "s3BucketName": CONFIG_BUCKET,
        "configSnapshotDeliveryProperties": {"deliveryFrequency": "TwentyFour_Hours"},
    }
    existing_channels = config.describe_delivery_channels()["DeliveryChannels"]
    if existing_channels:
        require(existing_channels == [channel], "existing_config_channel_drift")
    else:
        create_after_policy_propagation(
            config.put_delivery_channel, DeliveryChannel=channel
        )
        report["created"].append("config:default-delivery-channel")
    config.start_configuration_recorder(ConfigurationRecorderName="default")
    actual = config.describe_configuration_recorders()["ConfigurationRecorders"]
    require(
        len(actual) == 1
        and actual[0]["name"] == "default"
        and actual[0]["roleARN"] == CONFIG_ROLE_ARN
        and actual[0]["recordingGroup"]["allSupported"] is True
        and actual[0]["recordingGroup"]["includeGlobalResourceTypes"] is True
        and actual[0]["recordingGroup"]["recordingStrategy"]["useOnly"]
        == "ALL_SUPPORTED_RESOURCE_TYPES"
        and not actual[0]["recordingGroup"]
        .get("exclusionByResourceTypes", {})
        .get("resourceTypes")
        and actual[0]["recordingMode"]["recordingFrequency"] == "CONTINUOUS"
        and not actual[0]["recordingMode"].get("recordingModeOverrides"),
        "config_recorder_readback_mismatch",
    )
    require(
        config.describe_delivery_channels()["DeliveryChannels"] == [channel],
        "config_channel_readback_mismatch",
    )


def object_json(s3, bucket, key):
    response = s3.get_object(Bucket=bucket, Key=key, ExpectedBucketOwner=ACCOUNT)
    with response["Body"] as body:
        compressed = body.read(MAX_OBJECT_BYTES + 1)
    require(len(compressed) <= MAX_OBJECT_BYTES, "audit_object_too_large")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
        raw = stream.read(MAX_OBJECT_BYTES + 1)
    require(len(raw) <= MAX_OBJECT_BYTES, "audit_object_expands_too_large")
    return json.loads(raw)


def recent_objects(s3, bucket, prefix, started):
    pages = s3.get_paginator("list_objects_v2").paginate(
        Bucket=bucket,
        Prefix=prefix,
        ExpectedBucketOwner=ACCOUNT,
        PaginationConfig={"PageSize": 1000},
    )
    for number, page in enumerate(pages):
        require(number < 20, "audit_object_inventory_limit")
        for item in page.get("Contents", []):
            if item["LastModified"] >= started and item["Key"].endswith(".json.gz"):
                yield item["Key"]


def await_result(check, deadline, message):
    while True:
        result = check()
        if result:
            return result
        require(time.monotonic() < deadline, message)
        print(json.dumps({"waiting": message}), flush=True)
        time.sleep(20)


def verify_delivery(session, report, deadline):
    s3 = session.client("s3", config=SDK_CONFIG)
    trail = session.client("cloudtrail", config=SDK_CONFIG)
    config = session.client("config", config=SDK_CONFIG)
    started = dt.datetime.now(dt.timezone.utc)
    # Match this exact management request in a delivered S3 object, not event history.
    canary = trail.get_trail_status(Name=TRAIL_ARN)
    require(canary["IsLogging"] is True, "trail_not_logging")
    request_id = canary["ResponseMetadata"]["RequestId"]
    report["cloudTrailCanaryRequestId"] = request_id

    def config_discovered():
        status = config.describe_configuration_recorder_status(
            ConfigurationRecorderNames=["default"]
        )["ConfigurationRecordersStatus"]
        require(
            len(status) == 1 and status[0]["recording"] is True, "config_not_recording"
        )
        resources = config.list_discovered_resources(
            resourceType="AWS::S3::Bucket", resourceIds=[TRAIL_BUCKET, CONFIG_BUCKET]
        )["resourceIdentifiers"]
        return {r["resourceId"] for r in resources} == {TRAIL_BUCKET, CONFIG_BUCKET}

    await_result(config_discovered, deadline, "config_initial_inventory_pending")
    snapshot_id = config.deliver_config_snapshot(deliveryChannelName="default")[
        "configSnapshotId"
    ]
    report["configSnapshotRequested"] = snapshot_id
    checked = set()

    def delivered():
        if "cloudTrailDelivery" not in report:
            # A run crossing UTC midnight can receive objects under either date.
            for date in {started.date(), dt.datetime.now(dt.timezone.utc).date()}:
                prefix = f"AWSLogs/{ACCOUNT}/CloudTrail/{REGION}/{date:%Y/%m/%d}/"
                for key in recent_objects(s3, TRAIL_BUCKET, prefix, started):
                    if key in checked:
                        continue
                    checked.add(key)
                    data = object_json(s3, TRAIL_BUCKET, key)
                    for event in data["Records"]:
                        if (
                            event.get("requestID") == request_id
                            and event.get("eventName") == "GetTrailStatus"
                            and event.get("recipientAccountId") == ACCOUNT
                            and event.get("awsRegion") == REGION
                        ):
                            report["cloudTrailDelivery"] = {
                                "bucket": TRAIL_BUCKET,
                                "objectKey": key,
                                "requestId": request_id,
                                "eventTime": event["eventTime"],
                                "verified": True,
                            }
        if "configDelivery" not in report:
            prefix = f"AWSLogs/{ACCOUNT}/Config/{REGION}/"
            for key in recent_objects(s3, CONFIG_BUCKET, prefix, started):
                if "/ConfigSnapshot/" not in key or not key.endswith(
                    "_" + snapshot_id + ".json.gz"
                ):
                    continue
                snapshot = object_json(s3, CONFIG_BUCKET, key)
                require(
                    snapshot["fileVersion"] == "1.0"
                    and snapshot["configSnapshotId"] == snapshot_id,
                    "wrong_config_snapshot",
                )
                items = snapshot["configurationItems"]
                require(
                    all(item["awsAccountId"] == ACCOUNT for item in items),
                    "wrong_config_item_account",
                )
                buckets = {
                    item["resourceId"]
                    for item in items
                    if item["resourceType"] == "AWS::S3::Bucket"
                    and item["configurationItemStatus"] in {"OK", "ResourceDiscovered"}
                }
                require(
                    {TRAIL_BUCKET, CONFIG_BUCKET}.issubset(buckets),
                    "snapshot_missing_audit_bucket_items",
                )
                report["configDelivery"] = {
                    "bucket": CONFIG_BUCKET,
                    "objectKey": key,
                    "snapshotId": snapshot_id,
                    "configurationItemCount": len(items),
                    "auditBucketItemsVerified": True,
                    "verified": True,
                }
        return "cloudTrailDelivery" in report and "configDelivery" in report

    await_result(delivered, deadline, "fresh_audit_delivery_pending")

    def services_healthy():
        status = config.describe_delivery_channel_status(
            DeliveryChannelNames=["default"]
        )["DeliveryChannelsStatus"]
        recorder_status = config.describe_configuration_recorder_status(
            ConfigurationRecorderNames=["default"]
        )["ConfigurationRecordersStatus"]
        return (
            len(status) == 1
            and status[0]["configSnapshotDeliveryInfo"].get("lastStatus") == "SUCCESS"
            and len(recorder_status) == 1
            and recorder_status[0]["recording"] is True
            and recorder_status[0].get("lastStatus") == "SUCCESS"
        )

    await_result(services_healthy, deadline, "config_delivery_status_pending")
    final_trail_status = trail.get_trail_status(Name=TRAIL_ARN)
    require(
        final_trail_status["IsLogging"] is True
        and not final_trail_status.get("LatestDeliveryError"),
        "trail_unhealthy_after_verification",
    )


def run(session, report):
    s3 = session.client("s3", config=SDK_CONFIG)
    iam = session.client("iam", config=SDK_CONFIG)
    configure_bucket(s3, TRAIL_BUCKET, expected("cloudtrail-bucket.json"), report)
    configure_bucket(s3, CONFIG_BUCKET, expected("config-bucket.json"), report)
    configure_role(iam, report)
    configure_trail(session.client("cloudtrail", config=SDK_CONFIG), report)
    configure_config(session.client("config", config=SDK_CONFIG), report)
    report["configurationApplied"] = True
    verify_delivery(session, report, time.monotonic() + 25 * 60)
    report["freshDeliveryVerified"] = True
    report["result"] = "target_audit_delivery_verified"


def main():
    report = {
        "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "account": ACCOUNT,
        "region": REGION,
        "runId": os.environ.get("GITHUB_RUN_ID"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "headSha": os.environ.get("GITHUB_SHA"),
        "created": [],
        "buckets": [],
        "configurationApplied": False,
        "freshDeliveryVerified": False,
        "oldAccountChanged": False,
        "kmsChanged": False,
        "historicalLogsCopied": False,
        "retirementCleared": False,
    }
    result = 1
    try:
        run(workflow_identity(), report)
        result = 0
    except ClientError as error:
        # Provider error messages can contain private identifiers or payloads.
        code = error.response["Error"]["Code"]
        known = {
            "AccessDenied",
            "AccessDeniedException",
            "InsufficientPermissionsException",
            "InsufficientDeliveryPolicyException",
            "InvalidClientTokenId",
            "ExpiredToken",
            "BucketAlreadyExists",
            "BucketAlreadyOwnedByYou",
            "InvalidRoleException",
            "ThrottlingException",
        }
        report["failure"] = {
            "operation": error.operation_name,
            "code": code if code in known else "aws_request_failed",
        }
    except RuntimeError as error:
        report["failure"] = str(error)
    except Exception:
        report["failure"] = "unexpected_setup_or_verification_error"
    finally:
        report["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        if result:
            report["result"] = "incomplete_inspect_report"
        path = Path(os.environ["RUNNER_TEMP"]) / "aws-audit-target.json"
        path.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report), flush=True)
    return result


if __name__ == "__main__":
    sys.exit(main())
