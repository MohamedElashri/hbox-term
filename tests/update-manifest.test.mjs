import assert from "node:assert/strict";
import { test } from "node:test";
import { createManifest, REQUIRED } from "../tools/update-manifest.mjs";

// minisign layouts: public key = 2-byte algorithm + 8-byte key id + 32-byte key;
// signature = 2-byte algorithm + 8-byte key id + 64-byte signature.
const b64 = (text) => Buffer.from(text).toString("base64");
const key = (id) => b64(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), id, Buffer.alloc(32)]).toString("base64")}\n`);
const signature = (id) => b64(`untrusted comment: signature\n${Buffer.concat([Buffer.from("ED"), id, Buffer.alloc(64)]).toString("base64")}\ntrusted comment: timestamp:1\n${Buffer.alloc(64).toString("base64")}\n`);
const ours = Buffer.from("0123456789abcdef", "hex");
const theirs = Buffer.from("fedcba9876543210", "hex");

const NAMES = [
  "linux-amd64-appimage.AppImage", "linux-amd64-deb.deb", "linux-x86_64-rpm.rpm",
  "linux-aarch64-appimage.AppImage", "linux-arm64-deb.deb", "linux-aarch64-rpm.rpm",
  "darwin-x64-app.app.tar.gz", "darwin-aarch64-app.app.tar.gz",
].map((suffix) => `ternway-v0.1.0-${suffix}`);

function release({ sign = () => signature(ours), names = NAMES, tag = "v0.1.0", version = "0.1.0" } = {}) {
  const assets = [...names, ...names.map((name) => `${name}.sig`), "ternway-v0.1.0-darwin-x64-dmg.dmg", "SHA256SUMS.txt"];
  const signatures = Object.fromEntries(names.map((name) => [`${name}.sig`, sign(name)]));
  return createManifest({ version, tag, repository: "owner/ternway", notes: "Notes", publicKey: key(ours), assets, signatures, now: "2026-10-25T00:00:00Z" });
}

test("covers every package type with generic fallbacks", () => {
  const manifest = release();
  for (const target of REQUIRED) assert.ok(manifest.platforms[target], target);
  assert.equal(manifest.platforms["linux-x86_64"].url, manifest.platforms["linux-x86_64-appimage"].url);
  assert.equal(manifest.platforms["darwin-aarch64"].url, manifest.platforms["darwin-aarch64-app"].url);
  assert.equal(manifest.platforms["linux-aarch64-deb"].url, "https://github.com/owner/ternway/releases/download/v0.1.0/ternway-v0.1.0-linux-arm64-deb.deb");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.notes, "Notes");
});

test("rejects a missing platform", () => {
  assert.throws(() => release({ names: NAMES.filter((name) => !name.endsWith("rpm.rpm")) }), /linux-x86_64-rpm/);
});

test("rejects a signature from another key", () => {
  assert.throws(() => release({ sign: (name) => signature(name.includes("deb") ? theirs : ours) }), /different key/);
});

test("rejects a tag that does not match the version", () => {
  assert.throws(() => release({ tag: "v0.1.1" }), /does not match/);
});

test("branded beta bundles cover every update platform", () => {
  const version = "0.2.0-beta.1";
  const names = NAMES.map(name => name.replace("ternway-v0.1.0-", `ternway-v${version}-`));
  const manifest = release({ names, version, tag: `v${version}` });
  for (const target of REQUIRED) assert.ok(manifest.platforms[target], target);
  assert.equal(manifest.version, version);
  assert.match(manifest.platforms["darwin-aarch64"].url, /ternway-v0.2.0-beta.1-/);
});
test("rejects malformed prerelease version paths", () => {
  assert.throws(() => release({version:"0.2.0-beta/one",tag:"v0.2.0-beta/one"}), /does not match/);
});
