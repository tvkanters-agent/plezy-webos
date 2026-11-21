import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Only the push that increased the app version can publish it.
export function isVersionBump(previousVersion, currentVersion) {
  const parse = version => {
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error('Invalid webOS version: ' + String(version));
    }
    const result = version.split('.').map(Number);
    if (!result.every(Number.isSafeInteger)) {
      throw new Error('Unsafe webOS version: ' + version);
    }
    return result;
  };
  const previous = parse(previousVersion);
  const current = parse(currentVersion);
  for (let i = 0; i < 3; i++) {
    if (current[i] > previous[i]) return true;
    if (current[i] < previous[i]) return false;
  }
  return false;
}

export function decideRelease(previous, current) {
  return isVersionBump(previous.version, current.version) ? 'publish' : 'skip';
}

function readPackageAt(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha) || /^0+$/.test(sha)) {
    throw new Error('Expected a push commit SHA, received: ' + String(sha));
  }
  return JSON.parse(execFileSync('git',
    ['show', `${sha}:webos/package.json`], {encoding: 'utf8'}));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [before, after] = process.argv.slice(2);
    console.log(decideRelease(readPackageAt(before), readPackageAt(after)));
  } catch (error) {
    console.error('Unable to verify release eligibility:', error.message);
    process.exitCode = 1;
  }
}
