import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseCredentialErrors } from '../tools/release-credentials.mjs';
test('releases need only the updater signing key, without an Apple subscription', () => {
  const env = {HAS_TAURI_SIGNING_PRIVATE_KEY: 'true'};
  assert.deepEqual(releaseCredentialErrors(env), []);
  assert.match(releaseCredentialErrors({}).join(' '), /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(releaseCredentialErrors({HAS_TAURI_SIGNING_PRIVATE_KEY: 'false'}).join(' '), /TAURI_SIGNING_PRIVATE_KEY/);
  assert.ok(!releaseCredentialErrors({HAS_TAURI_SIGNING_PRIVATE_KEY: 'sensitive-value'}).join(' ').includes('sensitive-value'));
});
