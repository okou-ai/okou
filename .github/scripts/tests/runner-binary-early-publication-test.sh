#!/usr/bin/env bash
set -euo pipefail

export RUBYOPT="${RUBYOPT:-} -r$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workflow-test-owners.rb"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ruby -ryaml -rjson -rtmpdir -rfileutils -ropen3 -rdigest - "$REPO_ROOT" <<'RUBY'
root = ARGV.fetch(0)
workflow = load_workflow_test_owners("#{root}/.github/workflows/runner-image.yml")
compile = workflow.fetch("jobs").fetch("compile")
steps = compile.fetch("steps")
by_id = steps.filter_map { |step| [step["id"], step] if step["id"] }.to_h
raise "compiler must own the validated reuse index without an aggregate architecture barrier" unless
  compile.fetch("needs") == ["prepare"] && by_id.key?("shadow") && by_id.key?("manifest-upload")
first = steps.index { |step| step["name"] == "Stage runner binary transport" }
last = steps.index { |step| step["id"] == "manifest-upload" }
raise "missing target-local publication sequence" unless first && last && first < last
publication = steps[first..last]
raise "only immutable small indices may be optional" unless
  publication.select { |step| step["continue-on-error"] }.map { |step| step["id"] } == ["manifest-upload"] &&
  !by_id.fetch("manifest-upload").fetch("with").key?("overwrite") &&
  publication.all? { |step| !step.key?("if") }

AWS = <<'PYTHON'
#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
assert args[0] == 's3api'
op = args[1]; args = args[2:]; values = {}; dest = None
while args:
    if args[0].startswith('--'):
        values[args[0]] = args[1]; args = args[2:]
    else:
        dest = args[0]; args = args[1:]
key = values['--key']; path = pathlib.Path(os.environ['STORE']) / key
if os.environ.get('AWS_FAIL') == op:
    print('fixture failure X-Amz-Signature=fixture-secret', file=sys.stderr)
    sys.exit(7)
if op == 'put-object':
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    temp.write_bytes(pathlib.Path(values['--body']).read_bytes())
    if '--if-none-match' in values:
        try:
            os.link(temp, path)
        except FileExistsError:
            temp.unlink(); print('PreconditionFailed: 412', file=sys.stderr); sys.exit(1)
        temp.unlink()
    else:
        os.replace(temp, path)
elif op == 'head-object':
    if not path.is_file(): sys.exit(1)
    print(json.dumps({'ContentLength': path.stat().st_size}))
elif op == 'get-object':
    if not path.is_file(): sys.exit(1)
    data = path.read_bytes()
    if '--range' in values: data = data[:int(values['--range'].split('-')[1])+1]
    if os.environ.get('AWS_CORRUPT') == 'true' and key.endswith('.zst'): data = b'corrupt retained object'
    pathlib.Path(dest).write_bytes(data)
else:
    raise AssertionError('unexpected AWS operation: ' + op)
PYTHON
HTTP = <<'PYTHON'
#!/usr/bin/env python3
import io, json, os, pathlib, sys, urllib.parse, zipfile
args = sys.argv[1:]; store = pathlib.Path(os.environ['INDICES'])
url = urllib.parse.urlsplit(args[-1]); output = pathlib.Path(args[args.index('--output')+1])
if url.hostname == 'api.github.com':
    assert '--header' in args and 'Authorization: Bearer fixture-token' in sys.stdin.read()
    headers = pathlib.Path(args[args.index('--dump-header')+1]); headers.write_text('HTTP/2 200\r\n')
    endpoint = url.path
    if endpoint.endswith('/actions/artifacts'):
        if os.environ.get('GH_UNAVAILABLE') == 'true': sys.exit(1)
        name = urllib.parse.parse_qs(url.query)['name'][0]
        artifacts = []
        for run_dir in sorted(store.iterdir()):
            manifest = run_dir / name / 'manifest.json'
            if not manifest.is_file(): continue
            run = json.loads((run_dir / 'run.json').read_text())
            artifacts.append({'id': int(run_dir.name)+1000, 'name': name, 'expired': False,
              'size_in_bytes': manifest.stat().st_size, 'created_at': '2026-10-10T00:00:00Z',
              'workflow_run': {'id': run['id'], 'head_sha': run['head_sha'], 'head_branch': run['head_branch']}})
        output.write_text(json.dumps({'artifacts': artifacts}))
    elif '/actions/runs/' in endpoint:
        output.write_bytes((store / endpoint.rsplit('/',1)[1] / 'run.json').read_bytes())
    elif endpoint.endswith('/zip'):
        artifact = endpoint.split('/')[-2]
        headers.write_text('HTTP/2 302\r\nLocation: https://artifacts.fixture.test/'+artifact+'/zip?signature=private-fixture\r\n')
        output.write_text(''); print('302',end=''); sys.exit(0)
    else:
        raise AssertionError('unexpected GitHub endpoint: ' + endpoint)
elif url.hostname == 'artifacts.fixture.test':
    assert '--header' not in args, 'storage redirect received authorization'
    run = str(int(url.path.split('/')[1])-1000)
    manifests = list((store / run).glob('*/manifest.json'))
    assert len(manifests) == 1
    archive = io.BytesIO()
    with zipfile.ZipFile(archive,'w') as zipped:
        zipped.writestr('manifest.json',manifests[0].read_bytes())
    output.write_bytes(archive.getvalue())
else:
    raise AssertionError('unexpected external URL origin')
print('200',end='')
PYTHON

def command!(env, cwd, *command)
  output, error, status = Open3.capture3(env, *command, chdir: cwd)
  raise "#{command.first} failed: #{output}\n#{error}" unless status.success?
  output
end

def parse_outputs(path)
  File.readlines(path, chomp: true).to_h { |line| line.split("=", 2) }
end

Dir.mktmpdir("runner-index-") do |fixture|
  # A helper-only change must reach the real image selection boundary.
  selector = "#{fixture}/selector"
  FileUtils.mkdir_p("#{selector}/.github/scripts")
  %w[runner-image-context.sh runner-image-target.sh].each do |name|
    FileUtils.cp("#{root}/.github/scripts/#{name}", "#{selector}/.github/scripts/#{name}")
  end
  helper = "#{selector}/.github/scripts/runner-binary-github.sh"
  File.write(helper, "# baseline\n")
  command!({}, selector, "git", "init", "-q", "-b", "main")
  command!({}, selector, "git", "config", "user.email", "fixture@example.invalid")
  command!({}, selector, "git", "config", "user.name", "Workflow fixture")
  command!({}, selector, "git", "add", ".github/scripts")
  command!({}, selector, "git", "commit", "-q", "--no-verify", "-m", "baseline")
  base = command!({}, selector, "git", "rev-parse", "HEAD").strip
  File.write(helper, "# helper-only change\n")
  command!({}, selector, "git", "add", helper)
  command!({}, selector, "git", "commit", "-q", "--no-verify", "-m", "helper change")
  detector = workflow.fetch("jobs").fetch("prepare").fetch("steps").find { |step| step["id"] == "image-inputs" }
  code = detector.fetch("run").gsub("${{ steps.crates.outputs.runner-changed }}", "false")
  selected = command!({"BASE_REF" => base, "GITHUB_OUTPUT" => "#{selector}/output"}, selector,
    "bash", "-euo", "pipefail", "-c", code)
  raise "GitHub helper-only changes must select current runner images" unless selected.include?("runner-image-inputs-changed=true")
  tools = "#{fixture}/bin"
  store = "#{fixture}/store"
  indices = "#{fixture}/indices"
  FileUtils.mkdir_p([tools, store, indices])
  {"aws" => AWS, "curl" => HTTP}.each do |name, body|
    File.write("#{tools}/#{name}", body)
    FileUtils.chmod(0o755, "#{tools}/#{name}")
  end
  environment = {"PATH" => "#{tools}:#{ENV.fetch('PATH')}", "STORE" => store, "INDICES" => indices,
    "AWS_ACCESS_KEY_ID" => "fixture-access", "AWS_SECRET_ACCESS_KEY" => "fixture-secret",
    "R2_ACCOUNT_ID" => "fixture-account", "R2_BUCKET_NAME" => "fixture-bucket", "GH_TOKEN" => "fixture-token",
    "GITHUB_OUTPUT" => nil, "GITHUB_STEP_SUMMARY" => nil, "RUNNER_TEMP" => nil,
    "RUNNER_BINARY_CACHE_FORCE_MISS" => "false", "REPO" => "okou-ai/okou", "GITHUB_REPOSITORY_OWNER" => "okou-ai"}
  targets = %w[aarch64-unknown-linux-musl x86_64-unknown-linux-musl]
  digests = targets.to_h do |target|
    output = command!(environment, root, "#{root}/.github/scripts/runner-binary-build/digest.sh", target)
    [target, output.lines.find { |line| line.start_with?("binary-input-digest=") }.strip.split("=", 2).last]
  end
  guest_names = JSON.parse(File.read("#{root}/crates/runner/guest-binaries.json")).map { |guest| guest.fetch("binary") }
  guest_hashes = guest_names.to_h { |name| [name, Digest::SHA256.hexdigest(name)] }
  toolchain = command!(environment, root, "bash", "-c",
    '. .github/scripts/runner-binary-build/contract.env; printf %s "$RUNNER_BINARY_TOOLCHAIN_IMAGE"')
  matrix = targets.each_with_index.map do |target, i|
    {id: i.zero? ? "arm64" : "x86_64", label: i.zero? ? "arm64" : "x86_64", target: target,
     unameM: i.zero? ? "aarch64" : "x86_64", cacheSuffix: i.zero? ? "arm64" : "x86_64",
     assetSuffix: i.zero? ? "arm64" : "x86_64"}
  end
  make_producer = lambda do |run, target, bytes = "fresh #{target}\n"|
    cwd = "#{fixture}/producer-#{run}-#{target}"
    FileUtils.mkdir_p(["#{cwd}/.github/scripts/runner-binary-build", "#{cwd}/crates/runner",
      "#{cwd}/crates/target/#{target}/ci", "#{cwd}/runner-binary-fresh"])
    %w[runner-binary-cache.sh runner-binary-github.sh runner-binary-transport.sh runner-binary-download.sh runner-image-target.sh runner-guest-binaries.sh].each do |name|
      FileUtils.cp("#{root}/.github/scripts/#{name}", "#{cwd}/.github/scripts/#{name}")
    end
    FileUtils.cp("#{root}/.github/scripts/runner-binary-build/contract.env", "#{cwd}/.github/scripts/runner-binary-build/contract.env")
    FileUtils.cp("#{root}/crates/runner/guest-binaries.json", "#{cwd}/crates/runner/guest-binaries.json")
    File.write("#{cwd}/crates/target/#{target}/ci/runner", bytes)
    metadata = {schemaVersion: 1, target: target, binaryInputDigest: digests.fetch(target), toolchainImage: toolchain,
      guestSha256: guest_hashes, runnerSha256: Digest::SHA256.hexdigest(bytes), runnerSizeBytes: bytes.bytesize}
    File.write("#{cwd}/runner-binary-fresh/metadata.json", JSON.generate(metadata))
    run_dir = "#{indices}/#{run}"
    FileUtils.mkdir_p(run_dir)
    File.write("#{run_dir}/run.json", JSON.generate({id: run, status: "in_progress", run_attempt: 1,
      head_sha: "b" * 40, head_branch: "main", event: "push", path: ".github/workflows/runner-image.yml",
      repository: {full_name: "okou-ai/okou"}, pull_requests: []}))
    {run: run, target: target, cwd: cwd, outputs: {"build" => {"binary-input-digest" => digests.fetch(target)}}}
  end
  execute = lambda do |producer, selected, extra = {}|
    context = {"github.repository" => "okou-ai/okou", "github.run_id" => producer.fetch(:run).to_s,
      "github.run_attempt" => "1", "github.event_name" => "push", "github.token" => "fixture-token",
      "github.event.repository.default_branch" => "main", "matrix.target" => producer.fetch(:target),
      "needs.prepare.outputs.producer-head-sha" => "b" * 40, "needs.prepare.outputs.pr-number" => "",
      "needs.prepare.outputs.pr-head-ref" => "", "secrets.R2_ACCESS_KEY_ID" => "fixture-access",
      "secrets.R2_SECRET_ACCESS_KEY" => "fixture-secret", "vars.R2_ACCOUNT_ID" => "fixture-account",
      "vars.R2_USER_STORAGES_BUCKET_NAME" => "fixture-bucket"}
    producer.fetch(:outputs).each { |id, values| values.each { |key, value| context["steps.#{id}.outputs.#{key}"] = value } }
    selected.each do |step|
      # External AWS provisioning is supplied by the closed provider shim.
      next if step["uses"] == "./.github/actions/setup-aws-cli"
      resolve = lambda { |value| value.to_s.gsub(/\$\{\{\s*([^}]+?)\s*\}\}/) { context.fetch(Regexp.last_match(1).strip) } }
      env = environment.merge("TARGET_TRIPLE" => producer.fetch(:target))
      step.fetch("env", {}).each { |key, value| env[key] = resolve.call(value) }
      env.merge!(extra)
      output_file = "#{producer.fetch(:cwd)}/outputs"
      File.write(output_file, "")
      if step["run"]
        output, error, status = Open3.capture3(env.merge("GITHUB_OUTPUT" => output_file),
          "bash", "-euo", "pipefail", "-c", step.fetch("run"), chdir: producer.fetch(:cwd))
        unless status.success?
          producer[:failure] = "#{step.fetch('name')}: #{output}\n#{error}"
          return false
        end
        values = parse_outputs(output_file)
        producer.fetch(:outputs)[step["id"]] = values if step["id"]
        values.each { |key, value| context["steps.#{step['id']}.outputs.#{key}"] = value }
      elsif step.fetch("uses", "").start_with?("actions/upload-artifact@")
        settings = step.fetch("with")
        path = File.join(producer.fetch(:cwd), resolve.call(settings.fetch("path")))
        manifest = JSON.parse(File.read(path))
        raise "wrong producer index identity" unless manifest.fetch("producer").fetch("runId") == producer.fetch(:run) &&
          manifest.fetch("target") == producer.fetch(:target) && manifest.fetch("binaryInputDigest") == digests.fetch(producer.fetch(:target))
        dest = "#{indices}/#{producer.fetch(:run)}/#{resolve.call(settings.fetch('name'))}"
        if extra["UPLOAD_FAIL"] != "true" && !File.exist?("#{dest}/manifest.json")
          FileUtils.mkdir_p(dest)
          FileUtils.cp(path, "#{dest}/manifest.json")
        end
      else
        raise "unexpected publication step #{step}"
      end
    end
    true
  end
  plan = lambda do |name|
    out = "#{fixture}/plan-#{name}.outputs"
    File.write(out, "")
    command!(environment.merge("RUNNER_HOST_GROUPS_MATRIX" => JSON.generate(matrix),
      "RESOLVE_OUTPUT_DIR" => "#{fixture}/plan-#{name}", "GITHUB_OUTPUT" => out), root,
      "#{root}/.github/scripts/runner-binary-cache-plan.sh")
    parse_outputs(out)
  end
  before_upload = publication.take_while { |step| step["id"] != "shadow" }
  index_steps = publication.drop(before_upload.length)
  failed = make_producer.call(30, targets[0])
  raise "optional upload failure must not fail valid production" unless execute.call(failed, publication, "UPLOAD_FAIL" => "true")
  raise "failed optional upload advertised an index" unless Dir["#{indices}/30/*/manifest.json"].empty?
  raise "an absent optional index must retain safe compilation planning" unless plan.call("upload-unavailable").fetch("miss-count") == "2"
  arm = make_producer.call(20, targets[0])
  raise "fresh publication failed: #{arm[:failure]}" unless execute.call(arm, before_upload)
  missing_index = plan.call("object-ready")
  raise "an R2 object alone must not be mistaken for a discoverable input reference" unless missing_index.fetch("miss-count") == "2"
  raise "target-local index publication failed" unless execute.call(arm, index_steps)
  early = plan.call("arm-ready")
  raise "prepare must reuse the indexed target while the other architecture is unfinished" unless
    early.fetch("hit-count") == "1" && JSON.parse(early.fetch("compile-matrix")).map { |entry| entry.fetch("target") } == [targets[1]]
  x86 = make_producer.call(21, targets[1])
  raise "x86 publication failed" unless execute.call(x86, publication)
  ready = plan.call("both-ready")
  raise "a later prepare must eliminate both compiler jobs without waiting for workflow completion" unless
    ready.fetch("compile-matrix") == "[]" && ready.fetch("miss-count") == "0"
  targets.each do |target|
    destination = "#{fixture}/download-#{target}"
    command!(environment.merge("EXPECTED_TARGET" => target, "EXPECTED_BINARY_INPUT_DIGEST" => digests.fetch(target),
      "CACHE_REFERENCE" => JSON.generate(JSON.parse(ready.fetch("hit-references")).fetch(target)), "RESOLVE_OUTPUT_DIR" => destination),
      root, "#{root}/.github/scripts/runner-binary-cache.sh", "download-reference")
    raise "cached bytes differ from the verified producer" unless File.read("#{destination}/runner") == "fresh #{target}\n"
  end
  # The same current-run transport remains readable by a later consumer attempt.
  command!(environment.merge("CURRENT_RUN_ID" => "20", "EXPECTED_TARGET" => targets[0],
    "EXPECTED_BINARY_INPUT_DIGEST" => digests.fetch(targets[0]), "GITHUB_RUN_ATTEMPT" => "2",
    "OUTPUT_DIR" => "#{fixture}/consumer-rerun"), root, "#{root}/.github/scripts/runner-binary-transport.sh", "download")
  raise "consumer rerun changed producer provenance" unless JSON.parse(File.read("#{fixture}/consumer-rerun/manifest.json")).dig("producer", "runAttempt") == 1
  old_index = Dir["#{indices}/20/*/manifest.json"].fetch(0)
  old_bytes = File.read(old_index)
  raise "optional duplicate index upload broke a successful producer" unless execute.call(arm, index_steps)
  raise "rerun must not overwrite the immutable same-run index" unless File.read(old_index) == old_bytes

  discovery_error = make_producer.call(31, targets[0])
  raise "reported shadow discovery unavailability must retain optional-index semantics" unless execute.call(discovery_error, publication, "GH_UNAVAILABLE" => "true")
  raise "shadow discovery error must remain explicit" unless discovery_error.fetch(:outputs).fetch("shadow").fetch("shadow-reason") == "artifact-api-unavailable"
  %w[put-object get-object].each_with_index do |operation, i|
    producer = make_producer.call(40 + i, targets[0])
    raise "required storage failure must stop publication" if execute.call(producer, publication, "AWS_FAIL" => operation)
    raise "failed storage publication exposed an index" unless Dir["#{indices}/#{40+i}/*/manifest.json"].empty?
    raise "storage diagnostics leaked signed material" if producer.fetch(:failure).include?("fixture-secret")
  end
  corrupt = make_producer.call(50, targets[1])
  raise "corrupt retained bytes must stop publication" if execute.call(corrupt, publication, "AWS_CORRUPT" => "true")
  raise "corrupt bytes exposed an index" unless Dir["#{indices}/50/*/manifest.json"].empty?
  invalid = make_producer.call(51, targets[0])
  metadata_path = "#{invalid.fetch(:cwd)}/runner-binary-fresh/metadata.json"
  metadata = JSON.parse(File.read(metadata_path)); metadata["binaryInputDigest"] = "f" * 64
  File.write(metadata_path, JSON.generate(metadata))
  raise "invalid fresh identity must stop before publication" if execute.call(invalid, publication)
  raise "invalid metadata exposed an index" unless Dir["#{indices}/51/*/manifest.json"].empty?

  # A completed canonical source becomes an actual conflict-audit candidate.
  run_path = "#{indices}/20/run.json"
  completed = JSON.parse(File.read(run_path)); completed["status"] = "completed"
  File.write(run_path, JSON.generate(completed))
  conflict = make_producer.call(60, targets[0], "different output for identical input\n")
  raise "equal-input output conflict must block early indexing" if execute.call(conflict, publication)
  raise "conflicting producer exposed an index" unless Dir["#{indices}/60/*/manifest.json"].empty?
  raise "conflict must not replace another producer's index" unless File.read(old_index) == old_bytes

  # Independent equal-key writers keep distinct run indices and original provenance.
  writers = [make_producer.call(70, targets[1]), make_producer.call(71, targets[1])]
  results = writers.map { |producer| Thread.new { execute.call(producer, publication) } }.map(&:value)
  raise "healthy concurrent same-key writers failed" unless results.all?
  writers.each do |producer|
    manifests = Dir["#{indices}/#{producer.fetch(:run)}/*/manifest.json"]
    raise "writer lost its own immutable index" unless manifests.length == 1 &&
      JSON.parse(File.read(manifests[0])).dig("producer", "runId") == producer.fetch(:run)
  end
end
puts "runner-binary-early-publication-test: ok"
RUBY
