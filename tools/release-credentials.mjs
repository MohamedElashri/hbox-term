import { pathToFileURL } from 'node:url';

// The preflight receives presence flags, never private credential values.
export function releaseCredentialErrors(env) {
  const required = ['TAURI_SIGNING_PRIVATE_KEY', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_PRIVATE_KEY'];
  const errors = required.filter(name => env[`HAS_${name}`] !== 'true').map(name => `Missing GitHub Actions secret: ${name}`);
  if (!/^Developer ID Application: .+\([A-Z0-9]+\)$/.test(env.APPLE_SIGNING_IDENTITY || '')) errors.push('Set the APPLE_SIGNING_IDENTITY repository variable to a Developer ID Application identity.');
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = releaseCredentialErrors(process.env);
  if (errors.length) { process.stderr.write(`${errors.join('\n')}\nSee docs/RELEASE_CONFIDENCE.md before publishing.\n`); process.exitCode = 1; }
}
