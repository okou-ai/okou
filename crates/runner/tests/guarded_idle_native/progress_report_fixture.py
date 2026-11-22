"""Shared progress receipts for synthetic native report evidence."""


def joined_observer(started_ns, completed_ns):
    return {
        "started_ns": started_ns,
        "completed_ns": completed_ns,
        "available_bytes": 32 * 1024**3,
        "age_ns": 2,
        "read_duration_ns": 1,
        "joined": True,
    }


def foreground_heartbeat(runner_id, sequence, received_ns, completed_ns, allocated):
    allocated_vcpu, allocated_memory_mb = allocated
    return {
        "receipt": {
            "received_ns": received_ns,
            "acknowledgement_status": 204,
            "state": {
                "runnerId": runner_id,
                "snapshotGeneration": 1,
                "snapshotSequence": sequence,
                "group": "native-foreground",
                "mode": "running",
                "allocatedVcpu": allocated_vcpu,
                "allocatedMemoryMb": allocated_memory_mb,
            },
        },
        "send_joined": True,
        "completed_ns": completed_ns,
    }
