# Account erasure: activity copies (B2b2-R1, retired)

Scope: [#34434](https://github.com/vm0-ai/okou/issues/34434), one activity family
under [#33745](https://github.com/vm0-ai/okou/issues/33745).

Activity capture and activity summaries no longer pass the
[run-content ownership barrier](account-erasure-run-output.md). Since #36900
they read and write only the run's `active_agent_runs` row, with one primary-key
read and one single-row conditional update per step and no transaction, lock
chain or `activity` deadline profile. The row exists only while its run is
queued, pending or running: the launch statement inserts it, the terminal
transition deletes it, and deleting the run cascades to it.

A write that lands after an account closes is accepted, as for the other hot
paths whose erasure fence is being retired. It cannot outlive the run, and the
account-erasure inventory covers `active_agent_runs` through its `user_id`.
A summary claim still admits at most one finite auxiliary provider request;
closure cannot recall content already sent to the provider.
