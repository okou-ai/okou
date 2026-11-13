# These diagnostics are printed in CI. Never pass arbitrary response fields through.
def uuid:
    type == "string" and
    test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

def identity:
    if . == null then {state: "absent"}
    elif uuid then {state: "present", id: .}
    else {state: "invalid"} end;

def framework:
    if . == "codex" or . == "claude-code" or . == "pi" then .
    else "unavailable" end;

def sequence:
    if type == "number" and . >= 0 and . <= 9007199254740991 and floor == .
    then . else null end;

if length == 1 then .[0] else error("expected one JSON document") end |
if type != "object" then error("invalid snapshot")
elif $surface == "summary" then
    if (.runId | uuid) and (.threadId | uuid) and (.sessionId | uuid)
        and .status == "completed" then
        {state: "available", runId, threadId, sessionId}
    else error("invalid summary") end
elif $surface == "run" then
    if .runId != $runId then error("wrong Run") else
        {state: "available",
         framework: (.result.framework | framework),
         session: (if .result | has("frameworkSessionId") then
             .result.frameworkSessionId | identity
         else {state: "unavailable"} end)}
    end
elif $surface == "context" then
    if .runId != $runId then error("wrong Run") else
        {state: "available",
         framework: (.cliAgentType | framework),
         session: (if has("sessionId") then .sessionId | identity
                   else {state: "unavailable"} end)}
    end
elif $surface == "initialization" then
    if (.events | type) != "array" or (.hasMore | type) != "boolean"
    then error("invalid event page") else
        [.events[] | select(
            .eventType == "thread.started" or
            (.eventType == "system" and .eventData.subtype == "init")
        ) | {
            kind: (if .eventType == "thread.started" then "thread.started"
                   else "system.init" end),
            sequence: (.sequenceNumber | sequence),
            session: (if .eventType == "thread.started" then .eventData.thread_id
                      else .eventData.session_id end | identity)
        }] as $initializations |
        {state: "available", hasMore,
         initializations: $initializations[:8],
         omittedInitializations: ([$initializations | length - 8, 0] | max)}
    end
else error("unknown diagnostic surface") end
