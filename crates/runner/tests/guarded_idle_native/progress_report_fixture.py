"""Shared foreground heartbeat receipt for synthetic native report evidence."""


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
