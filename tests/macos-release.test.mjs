import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

for (const rejection of ['', 'signature', 'identity', 'image']) {
  test(`macOS release verification ${rejection ? `rejects invalid ${rejection}` : 'accepts an intact ad-hoc bundle and disk image'}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ternway-macos-release-'));
    const trace = join(root, 'trace');
    const command = `#!/bin/sh
name="$(basename "$0")"
printf '%s\\n' "$name $*" >> "$TEST_TRACE"
case "$name" in
  codesign)
    if [ "$1" = --verify ]; then
      [ "$TEST_REJECT" != signature ]
    elif [ "$TEST_REJECT" = identity ]; then
      echo 'Authority=Apple Development: Example' >&2
    else
      echo 'Signature=adhoc' >&2
    fi ;;
  hdiutil) [ "$TEST_REJECT" != image ] ;;
  *) exit 99 ;;
esac
`;
    try {
      for (const name of ['codesign', 'hdiutil', 'spctl', 'xcrun']) {
        const path = join(root, name);
        writeFileSync(path, command);
        chmodSync(path, 0o700);
      }
      const result = spawnSync('/bin/bash', [resolve('tools/verify-macos-release.sh'), join(root, 'Ternway.app'), join(root, 'Ternway.dmg')], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_TRACE: trace, TEST_REJECT: rejection }, encoding: 'utf8',
      });
      assert.equal(result.status === 0, !rejection, result.stdout + result.stderr);
      const calls = readFileSync(trace, 'utf8');
      assert.match(calls, /codesign --verify --deep --strict/);
      assert.doesNotMatch(calls, /(?:spctl|xcrun) /);
      if (!rejection) {
        assert.match(calls, /hdiutil verify/);
        assert.match(result.stdout, /not notarized by Apple/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
