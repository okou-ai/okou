"""Shared physical-observation and heartbeat receipts for held native work."""

import uuid

import pressure_report
import report

def identifier(value):
    return isinstance(value, str) and str(uuid.UUID(value)) == value


def observer(value, begin, end):
    if (not isinstance(value, dict) or set(value) != {"started_ns", "completed_ns", "available_bytes",
            "age_ns", "read_duration_ns", "joined"} or value["joined"] is not True
            or any(not pressure_report.integer(value[k]) for k in value if k != "joined")
            or not begin < value["started_ns"] < value["completed_ns"] < end
            or not 0 < value["available_bytes"]
            or not value["read_duration_ns"] <= value["age_ns"] <= value["completed_ns"]-value["started_ns"]
            or value["age_ns"] >= 5_000_000_000):
        raise ValueError("foreground observer did not complete a new joined real read inside the held wait")


def heartbeat(value, sequence, begin, end, allocated=(2, 4096)):
    if (not isinstance(value, dict) or set(value) != {"receipt", "send_joined", "completed_ns"}
            or value["send_joined"] is not True or not report.positive_integer(value["completed_ns"])):
        raise ValueError("foreground heartbeat send was not positively joined")
    receipt = value["receipt"]
    if (not isinstance(receipt, dict) or set(receipt) != {"received_ns", "acknowledgement_status", "state"}
            or type(receipt["acknowledgement_status"]) is not int or receipt["acknowledgement_status"] != 204
            or not report.positive_integer(receipt["received_ns"])
            or not begin < receipt["received_ns"] < value["completed_ns"] < end):
        raise ValueError("foreground heartbeat request/acknowledgement is outside the held wait")
    state = receipt["state"]
    if (not isinstance(state, dict) or not identifier(state.get("runnerId"))
            or not pressure_report.integer(state.get("snapshotGeneration"), 1)
            or type(state.get("snapshotSequence")) is not int or state["snapshotSequence"] != sequence
            or state.get("group") != "native-foreground" or state.get("mode") != "running"
            or type(state.get("allocatedVcpu")) is not int or state["allocatedVcpu"] != allocated[0]
            or type(state.get("allocatedMemoryMb")) is not int or state["allocatedMemoryMb"] != allocated[1]):
        raise ValueError("foreground heartbeat lost its original generation/sequence/full lease")
    return state["runnerId"], state["snapshotGeneration"]
