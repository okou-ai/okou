# workspace-workflow-permissions

## workspace-workflow-permissions-001

- Vitest: "ordinary members create and copy private Workflows without gaining public rights"
- Mode: run
- Given: A Team administrator owns a public Workflow with instructions and a reference file. Alice and Bob are ordinary workspace members.
- When: Alice creates a private Workflow, copies and edits the public Workflow, then attempts a duplicate copy, public creation, publication and edits or deletion of the source. The administrator updates the source. Both members read their lists, composer and Workflow details.
- Then: Creation and copy return HTTP 201 with Alice as private owner who can manage and cannot publish. The initial copy includes the source instruction and file. Editing it returns HTTP 200 and recopying returns HTTP 409. Public creation, publishing as a member and editing or deleting the source are forbidden. Even as admin, publishing the same-name copy conflicts. Alice’s composer and list resolve the private copy while Bob sees the latest public definition and gets 404 for the copy. Alice retains her override, and initiating chat from the public Workflow references its original ID.

## workspace-workflow-permissions-002

- Vitest: "copies only the caller's Automations and preserves the existing private copy"
- Mode: run
- Given: An administrator and a member each create a schedule on the same public Workflow, with respective 1,800 and 900 second intervals.
- When: The member copies the public Workflow and lists the copy’s Automations.
- Then: Copy returns HTTP 201 and the HTTP 200 list contains only one Automation owned by the member, a loop scheduled every 900 seconds.
