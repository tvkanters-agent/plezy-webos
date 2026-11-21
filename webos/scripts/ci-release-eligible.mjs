import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// A master build publishes only if this exact commit increased the app version.
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // fetch-depth: 2 ensures the first parent exists; reruns see the same parent.
    const previous = JSON.parse(execFileSync('git',
      ['show', 'HEAD^:webos/package.json'], {encoding: 'utf8'}));
    const current = JSON.parse(readFileSync('webos/package.json', 'utf8'));
    console.log(decideRelease(previous, current));
  } catch (error) {
    console.error('Unable to verify release eligibility:', error.message);
    process.exitCode = 1;
  }
}
