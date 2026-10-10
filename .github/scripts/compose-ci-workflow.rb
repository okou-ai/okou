#!/usr/bin/env ruby
# Compose native readiness edges without making whole reusable workflows barriers.
require "yaml"

ROOT = File.expand_path("../..", __dir__)
TARGETS = {
  "arm64" => "aarch64-unknown-linux-musl",
  "x86_64" => "x86_64-unknown-linux-musl"
}.freeze
SELECTED_JOBS = %w[
  runner-test-prepare runner-behavior-lane-a runner-behavior-lane-b
  runner-behavior-lane-c runner-behavior-lane-d host-cpu-fairness-test
  guest-rpc-firecracker-test
].freeze
PARTITIONED_JOBS = (SELECTED_JOBS + ["runner-image-architecture-manifest"]).freeze
OUTPUT = File.join(ROOT, ".github/workflows/ci.yml")

# Rewriting only needs.<job> preserves step IDs, shell bodies and artifact names.
def rewrite(value, mapping)
  case value
  when Hash
    value.to_h { |key, child| [key, rewrite(child, mapping)] }
  when Array
    value.map { |child| rewrite(child, mapping) }
  when String
    value.gsub(/\bneeds\.([a-zA-Z0-9_-]+)/) { "needs.#{mapping.fetch(Regexp.last_match(1))}" }
  else
    value
  end
end

def dependencies(job)
  Array(job.fetch("needs", []))
end

def mapped_job(source, mapping)
  job = rewrite(source, mapping)
  job["needs"] = dependencies(source).map { |id| mapping.fetch(id) } if source.key?("needs")
  job
end

def expression(value)
  value.to_s.strip.sub(/\A\$\{\{\s*/, "").sub(/\s*\}\}\z/, "")
end

def require_condition(job, condition)
  original = expression(job.fetch("if", "true"))
  job["if"] = "${{ !cancelled() && (#{original}) && (#{condition}) }}"
end

def current_run_consumer(job)
  job.fetch("steps").each do |step|
    next unless %w[.github/scripts/wait-runner-image.sh .github/scripts/wait-runner-image-groups.sh].include?(step["run"])
    step.fetch("env")["RUNNER_IMAGE_RUN_ID"] = "${{ github.run_id }}"
    step.fetch("env").delete("LOOKUP_SHA")
  end
end

def put_job(jobs, id, job)
  raise "duplicate CI job id: #{id}" if jobs.key?(id)
  jobs[id] = job
end

def compose
  modules = %w[turbo crates runner-image].to_h do |name|
    [name, YAML.safe_load_file(File.join(ROOT, ".github/workflows/#{name}.yml"))]
  end
  modules.each do |name, document|
    # Psych's YAML 1.1 parser treats an unquoted Actions `on` key as true.
    unknown = document.keys - ["name", "on", true, "concurrency", "env", "jobs"]
    raise "#{name}: unhandled workflow-level settings: #{unknown.join(', ')}" unless unknown.empty?
    raise "#{name}: workflow environments differ" unless document.fetch("env") == modules.fetch("turbo").fetch("env")
  end
  turbo = modules.fetch("turbo")
  crates = modules.fetch("crates")
  image = modules.fetch("runner-image")
  jobs = {}
  turbo_map = turbo.fetch("jobs").keys.to_h { |id| [id, id] }
  crates_map = crates.fetch("jobs").keys.to_h { |id| [id, id == "ci-gate-crates" ? id : "crates-#{id}"] }
  image_map = image.fetch("jobs").keys.to_h { |id| [id, "image-#{id}"] }

  image.fetch("jobs").each do |id, source|
    next if id == "build"
    job = mapped_job(source, image_map)
    if id == "cancel-superseded"
      job["if"] = "github.event_name == 'pull_request' || github.event_name == 'merge_group'"
      step = job.fetch("steps").find { |entry| entry["run"] == ".github/scripts/cancel-superseded-merge-group-runs.sh" }
      step.fetch("env")["RUNNER_OWNER_EVENT_NAME"] = "${{ github.event_name }}"
      step.fetch("env")["PR_NUMBER"] = "${{ github.event.pull_request.number }}"
    elsif id == "prepare"
      # CLI preparation/cache planning is immutable and run-local. Overlap it
      # with owner cancellation; only host-mutating image builds need handoff.
      job.delete("needs")
      job["if"] = "!cancelled()"
      TARGETS.each_key do |arch|
        job.fetch("outputs")["image-matrix-#{arch}"] = "${{ steps.image-partition.outputs.#{arch} }}"
      end
      job.fetch("steps") << {
        "name" => "Partition image readiness by architecture", "id" => "image-partition",
        "env" => {
          "IMAGE_NEEDED" => "${{ steps.needed.outputs.current-runner-image-needed }}",
          "IMAGE_MATRIX" => "${{ steps.host-groups.outputs.matrix || '[]' }}"
        },
        "run" => ".github/scripts/partition-ci-image-matrix.sh"
      }
    end
    job.fetch("steps").each do |step|
      next unless step["run"] == ".github/scripts/runner-binary-transport.sh publish"
      step.fetch("env")["PRODUCER_WORKFLOW_PATH"] = ".github/workflows/ci.yml"
    end
    put_job(jobs, image_map.fetch(id), job)
  end
  TARGETS.each_key do |arch|
    job = mapped_job(image.fetch("jobs").fetch("build"), image_map)
    job.fetch("strategy").fetch("matrix")["include"] = "${{ fromJSON(needs.image-prepare.outputs.image-matrix-#{arch} || '[]') }}"
    job["needs"] = dependencies(job) + ["image-cancel-superseded"]
    require_condition(job, "needs.image-prepare.outputs.image-matrix-#{arch} != '[]' && needs.image-cancel-superseded.result == 'success'")
    put_job(jobs, "image-build-#{arch}", job)
  end

  turbo.fetch("jobs").each do |id, source|
    job = mapped_job(source, turbo_map)
    if id == "deploy-runner-prepare"
      job["needs"] = dependencies(job) + ["image-prepare"] + TARGETS.keys.map { |arch| "image-build-#{arch}" }
      ready = TARGETS.keys.map do |arch|
        "(needs.image-build-#{arch}.result == 'success' || (needs.image-prepare.outputs.image-matrix-#{arch} == '[]' && needs.image-build-#{arch}.result == 'skipped'))"
      end.join(" && ")
      require_condition(job, "needs.prepare.result == 'success' && needs.image-prepare.result == 'success' && #{ready}")
      current_run_consumer(job)
    end
    put_job(jobs, id, job)
  end

  crates.fetch("jobs").each do |id, source|
    if PARTITIONED_JOBS.include?(id)
      TARGETS.each do |arch, target|
        mapping = crates_map.merge(PARTITIONED_JOBS.to_h { |name| [name, "crates-#{name}-#{arch}"] })
        job = mapped_job(source, mapping)
        if id == "runner-test-prepare" || id == "runner-image-architecture-manifest"
          job["needs"] = dependencies(job) + ["image-build-#{arch}"]
          operator = id == "runner-test-prepare" ? "==" : "!="
          require_condition(job, "needs.crates-detect.result == 'success' && needs.crates-runner-host-groups.result == 'success' && needs.crates-runner-host-groups.outputs.selected-target #{operator} '#{target}' && needs.image-build-#{arch}.result == 'success'")
          current_run_consumer(job)
        end
        put_job(jobs, mapping.fetch(id), job)
      end
    elsif id == "ci-gate-crates"
      # A gate has both variants as dependencies, but consumes the planned target's
      # results. Its complementary manifest validates the other configured target.
      job = mapped_job(source, crates_map)
      job["needs"] = dependencies(source).flat_map do |name|
        PARTITIONED_JOBS.include?(name) ? TARGETS.keys.map { |arch| "crates-#{name}-#{arch}" } : [crates_map.fetch(name)]
      end
      selector = "needs.crates-runner-host-groups.outputs.selected-target == '#{TARGETS.fetch('arm64')}'"
      job.fetch("steps").each do |step|
        next unless step.key?("run")
        PARTITIONED_JOBS.each do |name|
          left, right = name == "runner-image-architecture-manifest" ? %w[x86_64 arm64] : %w[arm64 x86_64]
          step["run"] = step.fetch("run").gsub("needs.crates-#{name}.result", "(#{selector} && needs.crates-#{name}-#{left}.result || needs.crates-#{name}-#{right}.result)")
        end
        next unless step["name"] == "Validate CI results"
        step.fetch("env")["SELECTED_TARGET"] = "${{ needs.crates-runner-host-groups.outputs.selected-target }}"
        %w[a b c d].each do |lane|
          step["run"] = step.fetch("run").gsub(
            /^(          )?check_result "runner-behavior-lane-#{lane}" (.+) "true"$/,
            '\\1check_result "runner-behavior-lane-' + lane + '" \\2 "$RUNNER_IMAGE_ALLOW_SKIP"'
          )
        end
        checks = TARGETS.map do |arch, target|
          entries = SELECTED_JOBS.map do |name|
            "  [ \"${{ needs.crates-#{name}-#{arch}.result }}\" = skipped ] || { echo \"::error::Unselected #{name} (#{arch}) executed or was cancelled\"; FAILED=1; }"
          end.join("\n")
          <<~SH
            if [ "$SELECTED_TARGET" != "#{target}" ]; then
            #{entries}
            fi
            if [ "$SELECTED_TARGET" = "#{target}" ] || [ "$RUNNER_IMAGE_NEEDED" != true ]; then
              [ "${{ needs.crates-runner-image-architecture-manifest-#{arch}.result }}" = skipped ] || { echo "::error::Unselected manifest (#{arch}) executed or was cancelled"; FAILED=1; }
            fi
          SH
        end.join("\n")
        validation = <<~SH
          if [ "$RUNNER_IMAGE_NEEDED" = true ]; then
            case "$SELECTED_TARGET" in
              aarch64-unknown-linux-musl|x86_64-unknown-linux-musl) ;;
              *) echo "::error::Missing or unsupported selected target"; FAILED=1 ;;
            esac
          fi
          #{checks}
        SH
        step["run"] = step.fetch("run").sub("exit $FAILED", "#{validation}\nexit $FAILED")
      end
      put_job(jobs, id, job)
    else
      put_job(jobs, crates_map.fetch(id), mapped_job(source, crates_map))
    end
  end

  jobs.each do |id, job|
    dependencies(job).each { |need| raise "#{id}: missing dependency #{need}" unless jobs.key?(need) }
    # Every needs expression must name a direct dependency, not merely an ancestor.
    job.to_yaml.scan(/\bneeds\.([a-zA-Z0-9_-]+)/).flatten.each do |need|
      raise "#{id}: needs expression is not a direct dependency: #{need}" unless dependencies(job).include?(need)
    end
  end
  visiting = []
  visited = []
  visit = lambda do |id|
    raise "cycle: #{(visiting + [id]).join(' -> ')}" if visiting.include?(id)
    return if visited.include?(id)
    visiting << id
    dependencies(jobs.fetch(id)).each { |need| visit.call(need) }
    visiting.pop
    visited << id
  end
  jobs.each_key { |id| visit.call(id) }
  {
    "name" => "CI", "on" => {"pull_request" => nil, "merge_group" => nil},
    "concurrency" => {
      "group" => "${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('merge-queue-{0}', github.run_id) }}",
      "cancel-in-progress" => "${{ github.event_name == 'pull_request' }}"
    },
    "env" => turbo.fetch("env"), "jobs" => jobs
  }
end

workflow = compose
case ARGV
when []
  File.write(OUTPUT, "# Generated by .github/scripts/compose-ci-workflow.rb; edit the source modules instead.\n" + workflow.to_yaml.sub(/\A---\n/, ""))
  puts "Generated #{OUTPUT} (#{workflow.fetch('jobs').length} native jobs)"
when ["--check"]
  abort "ci.yml is stale; run ruby .github/scripts/compose-ci-workflow.rb" unless File.file?(OUTPUT) && YAML.safe_load_file(OUTPUT) == workflow
  puts "CI composition is current"
else
  abort "Usage: ruby .github/scripts/compose-ci-workflow.rb [--check]"
end
