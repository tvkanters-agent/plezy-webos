import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workflow = readFileSync(new URL('../../.github/workflows/webos.yml', import.meta.url), 'utf8');

test('master releases retain distinct pending runs and superseded PR runs cancel', () => {
  const concurrency = workflow.match(/^concurrency:\n(?:(?: {2}.*|[ \t]*#.*)\n)+/m)?.[0];
  assert.ok(concurrency, 'expected top-level workflow concurrency');
  assert.match(concurrency,
    /group: webos-\$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| format\('run-\{0\}', github\.run_id\) \}\}/);
  assert.match(concurrency,
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('master release publication still waits for the complete validation gate', () => {
  assert.match(workflow, /test-and-package:\n    name: test-and-package\n    needs: \[unit, build-and-package, e2e\]/);
  assert.match(workflow, /release:\n    needs: test-and-package\n    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'/);
  assert.match(workflow, /--prerelease --target "\$GITHUB_SHA"/);
});
