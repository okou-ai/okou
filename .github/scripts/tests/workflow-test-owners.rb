# Read the actual execution owner into the logical context of a job-body fixture.
# The native CI graph/gate regression deliberately does not use this adapter.
require "json"
require "open3"

def load_workflow_test_owners(path)
  reader = File.join(__dir__, "load-workflow-test-owners.py")
  stdout, stderr, status = Open3.capture3("python3", reader, path)
  raise "owner context reader failed: #{stderr}" unless status.success?
  JSON.parse(stdout)
end
