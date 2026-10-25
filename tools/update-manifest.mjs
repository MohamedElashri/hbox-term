// Builds the updater manifest (latest.json) for a release from its signed assets, after every
// build job has uploaded them. It fails the release if a platform is missing or a signature was
// made with a different key than the one in tauri.conf.json.
//
//   node tools/update-manifest.mjs ASSETS_DIR RELEASE_JSON OUTPUT
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLES = { "appimage.AppImage": ["linux", "appimage"], "deb.deb": ["linux", "deb"], "rpm.rpm": ["linux", "rpm"], "app.app.tar.gz": ["darwin", "app"] };
const ARCHES = { x86_64: "x86_64", x64: "x86_64", amd64: "x86_64", aarch64: "aarch64", arm64: "aarch64" };
// The generic `{os}-{arch}` entry serves builds that do not know their package type.
const FALLBACK = { linux: "appimage", darwin: "app" };
export const REQUIRED = ["x86_64", "aarch64"].flatMap((arch) => [`linux-${arch}-appimage`, `linux-${arch}-deb`, `linux-${arch}-rpm`, `darwin-${arch}-app`]);

/** The 8-byte key id in a minisign public key or signature (base64 of the second line). */
function keyId(encoded, length) {
  const lines = Buffer.from(encoded.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  const raw = Buffer.from(lines[1] ?? "", "base64");
  if (raw.length !== length) throw new Error("not a minisign key or signature");
  return raw.subarray(2, 10).toString("hex");
}

/** `signatures` maps asset file names ending in `.sig` to their contents; `assets` lists every asset name. */
export function createManifest({ version, tag, repository, notes, publicKey, assets, signatures, now = new Date().toISOString() }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}`) throw new Error(`Tag ${tag} does not match app version ${version}`);
  const key = keyId(publicKey, 42);
  const prefix = `hbox-term-v${version}-`;
  const pattern = new RegExp(`^(linux|darwin)-(${Object.keys(ARCHES).join("|")})-(${Object.keys(BUNDLES).map((name) => name.replaceAll(".", "\\.")).join("|")})\\.sig$`);
  const platforms = {};
  for (const [name, content] of Object.entries(signatures)) {
    const match = name.startsWith(prefix) && pattern.exec(name.slice(prefix.length));
    if (!match) continue;
    const [, os, arch, bundle] = match;
    const [bundleOs, installer] = BUNDLES[bundle];
    if (os !== bundleOs) throw new Error(`${name}: ${bundle} is not a ${os} bundle`);
    const asset = name.slice(0, -".sig".length);
    if (!assets.includes(asset)) throw new Error(`${name}: ${asset} is missing`);
    const signature = content.trim();
    if (keyId(signature, 74) !== key) throw new Error(`${name}: signed with a different key`);
    const target = `${os}-${ARCHES[arch]}-${installer}`;
    if (platforms[target]) throw new Error(`Two assets for ${target}`);
    platforms[target] = { signature, url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(asset)}` };
    if (FALLBACK[os] === installer) platforms[`${os}-${ARCHES[arch]}`] = platforms[target];
  }
  const missing = REQUIRED.filter((target) => !platforms[target]);
  if (missing.length) throw new Error(`No signed update for ${missing.join(", ")}`);
  const sorted = Object.fromEntries(Object.entries(platforms).sort(([a], [b]) => a.localeCompare(b)));
  return { version, notes, pub_date: now, platforms: sorted };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, releaseFile, output] = process.argv.slice(2);
  if (!directory || !releaseFile || !output) throw new Error("Usage: node tools/update-manifest.mjs ASSETS_DIR RELEASE_JSON OUTPUT");
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const release = JSON.parse(readFileSync(releaseFile, "utf8"));
  const assets = readdirSync(directory);
  const signatures = Object.fromEntries(assets.filter((name) => name.endsWith(".sig")).map((name) => [name, readFileSync(join(directory, name), "utf8")]));
  const manifest = createManifest({
    version: config.version, tag: release.tag_name, repository: process.env.GITHUB_REPOSITORY, notes: release.body ?? "",
    publicKey: config.plugins.updater.pubkey, assets, signatures,
  });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json covers ${Object.keys(manifest.platforms).join(", ")}`);
}
