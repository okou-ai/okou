#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ruby - "$repo_root" <<'RUBY'
require "tmpdir"
require "fileutils"
require "open3"
root = ARGV.fetch(0)
script = "#{root}/.github/scripts/desktop/dependency-cache-key.sh"
locks = ["desktop/Package.resolved", "desktop/ComputerUse/Package.resolved",
  "desktop/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"]
Dir.mktmpdir("desktop-cache-inputs") do |dir|
  bin = "#{dir}/bin"
  Dir.mkdir(bin)
  {"sw_vers" => 'printf "%s" "${TEST_OS:-26.6.2}"',
   "uname" => 'printf "%s" "${TEST_ARCH:-arm64}"',
   "xcodebuild" => 'test "${TEST_FAIL_TOOL:-}" != xcodebuild; printf "%s" "${TEST_XCODE:-Xcode 26.6 build 17F113}"',
   "xcrun" => 'if [[ "$1" == swift ]]; then printf "%s" "${TEST_SWIFT:-Swift 6.3.3}"; else printf "%s" "${TEST_SDK:-26.5}"; fi'}.each do |name, body|
    File.write("#{bin}/#{name}", "#!/usr/bin/env bash\nset -euo pipefail\n#{body}\n")
    FileUtils.chmod(0755, "#{bin}/#{name}")
  end
  locks.each do |lock|
    FileUtils.mkdir_p(File.dirname("#{dir}/#{lock}"))
    FileUtils.cp("#{root}/#{lock}", "#{dir}/#{lock}")
  end
  run = lambda do |extra = {}|
    Open3.capture3({"PATH" => "#{bin}:#{ENV.fetch('PATH')}"}.merge(extra), "bash", script, chdir: dir)
  end
  key, error, status = run.call
  raise "identity failed: #{error}" unless status.success? && key.match?(/\Akey=desktop-swiftpm-downloads-v1-[0-9a-f]{64}-[0-9a-f]{64}\n\z/)
  locks.each do |lock|
    original = File.read("#{dir}/#{lock}")
    File.write("#{dir}/#{lock}", original + "\n")
    changed, _, result = run.call
    raise "lock did not invalidate #{lock}" unless result.success? && changed != key
    File.write("#{dir}/#{lock}", original)
  end
  %w[TEST_OS TEST_ARCH TEST_XCODE TEST_SWIFT TEST_SDK].each do |input|
    changed, _, result = run.call({input => "changed"})
    raise "toolchain did not invalidate #{input}" unless result.success? && changed != key
  end
  File.write("#{dir}/desktop/unrelated.swift", "// no dependency change\n")
  unchanged, _, result = run.call
  raise "source-only edits grew the dependency key" unless result.success? && unchanged == key
  failed, _, result = run.call({"TEST_FAIL_TOOL" => "xcodebuild"})
  raise "failed native tool published a key" if result.success? || !failed.empty?
  File.unlink("#{dir}/#{locks.last}")
  failed, _, result = run.call
  raise "missing lock published a key" if result.success? || !failed.empty?
end
puts "Desktop dependency identity tests passed"
RUBY
