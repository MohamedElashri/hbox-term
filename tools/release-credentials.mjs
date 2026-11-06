import { pathToFileURL } from 'node:url';

// The preflight receives presence flags, never private credential values.
export function releaseCredentialErrors(env) {
  const required = ['TAURI_SIGNING_PRIVATE_KEY'];
  const errors = required.filter(name => env[`HAS_${name}`] !== 'true').map(name => `Missing GitHub Actions secret: ${name}`);
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = releaseCredentialErrors(process.env);
  if (errors.length) { process.stderr.write(`${errors.join('\n')}\nSee DEVELOPER_GUIDE.md for updater signing.\n`); process.exitCode = 1; }
}
