import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseCredentialErrors } from '../tools/release-credentials.mjs';
test('production release gates reject missing Apple credentials and ad-hoc signing', () => {
  const env = Object.fromEntries(['TAURI_SIGNING_PRIVATE_KEY', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_PRIVATE_KEY'].map(name => [`HAS_${name}`, 'true']));
  env.APPLE_SIGNING_IDENTITY = 'Developer ID Application: Example (TEAM123456)';
  assert.deepEqual(releaseCredentialErrors(env), []);
  for (const identity of ['-', '', 'Apple Development: Example']) assert.match(releaseCredentialErrors({...env, APPLE_SIGNING_IDENTITY: identity}).join(' '), /Developer ID/);
  assert.match(releaseCredentialErrors({...env, HAS_APPLE_API_PRIVATE_KEY: 'false'}).join(' '), /APPLE_API_PRIVATE_KEY/);
  assert.ok(!releaseCredentialErrors({...env, HAS_APPLE_CERTIFICATE: 'sensitive-value'}).join(' ').includes('sensitive-value'));
});
