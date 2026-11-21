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

test('release job compares the immutable pre-push and tested revisions before publishing', () => {
  const release = workflow.split(/^  release:\n/m)[1];
  assert.ok(release, 'release job must exist');
  assert.match(release, /- uses: actions\/checkout@v4\n        with:\n          ref: \$\{\{ github\.sha \}\}/);
  assert.match(release, /PUSH_BEFORE: \$\{\{ github\.event\.before \}\}/);
  assert.match(release, /git fetch --no-tags --depth=1 origin "\$PUSH_BEFORE"/);
  assert.match(release, /decision=\$\(node webos\/scripts\/ci-release-eligible\.mjs "\$PUSH_BEFORE" "\$GITHUB_SHA"\)/);
  assert.match(release, /Publish versioned webOS release when release notes exist\n        if: steps\.eligibility\.outputs\.decision == 'publish'/);
  assert.match(release, /if gh release view "v\$\{version\}" >\/dev\/null 2>&1; then exit 0; fi/);
});
