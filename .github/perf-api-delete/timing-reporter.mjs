import { writeFileSync } from 'node:fs';
export default class TimingReporter {
  onTestRunEnd(modules, errors, reason) {
    const files = modules.map(mod => ({moduleId:mod.moduleId, diagnostic:mod.diagnostic(), state:mod.state(), tests:[...mod.children.allTests()].length}));
    writeFileSync(process.env.DELETE_LAB_TIMINGS, JSON.stringify({reason,errors:errors.map(e=>String(e)),files},null,2));
  }
}
