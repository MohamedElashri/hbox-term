import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Every external installer command is a fixture. Nothing contacts GitHub,
// mounts a disk image or changes /Applications during these tests.
for (const rejection of ["", "checksum", "codesign"]) {
  test(`macOS installer ${rejection ? `preserves the installed app after ${rejection} rejection` : "verifies a package before replacing the app"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "ternway-installer-test-"));
    const trace = join(root, "trace");
    const command = `#!/bin/sh
name="$(basename "$0")"
printf '%s\\n' "$name $*" >> "$TEST_TRACE"
case "$name" in
  mktemp) mkdir "$TEST_ROOT/work"; echo "$TEST_ROOT/work" ;;
  uname) [ "$1" = -s ] && echo Darwin || echo arm64 ;;
  gh)
    case "$1 $2" in
      'auth status') exit 0 ;;
      'release view') echo ternway_0.3.0_aarch64.dmg ;;
      'release download')
        shift 2
        while [ "$#" -gt 0 ]; do
          case "$1" in -p) asset=$2; shift ;; -D) destination=$2; shift ;; esac
          shift
        done
        : > "$destination/$asset" ;;
    esac ;;
  sha256sum) [ "$TEST_REJECT" != checksum ] ;;
  hdiutil) [ "$1" != attach ] || mkdir -p "$5/Ternway.app" ;;
  codesign|spctl) [ "$TEST_REJECT" != "$name" ] ;;
  xcrun) [ "$TEST_REJECT" != stapler ] ;;
  cp) exit 0 ;;
  rm) exit 0 ;;
  xattr) exit 99 ;;
esac
`;
    try {
      for (const name of ["mktemp", "uname", "gh", "sha256sum", "hdiutil", "codesign", "spctl", "xcrun", "cp", "rm", "xattr"]) {
        const path = join(root, name);
        writeFileSync(path, command);
        chmodSync(path, 0o700);
      }
      const result = spawnSync("/bin/sh", [resolve("install.sh")], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_ROOT: root, TEST_TRACE: trace, TEST_REJECT: rejection, TERNWAY_VERSION: "v0.3.0" },
        encoding: "utf8",
      });
      const calls = readFileSync(trace, "utf8").split("\n");
      assert.ok(!calls.some(line => line.startsWith("xattr ")), "Installer must keep macOS security protections intact");
      assert.ok(!calls.some(line => line.startsWith("spctl ") || line.startsWith("xcrun ")), "Ad-hoc packages do not require Apple notarization or change Gatekeeper settings");
      const replacement = calls.findIndex(line => line === "rm -rf /Applications/Ternway.app");
      if (rejection) {
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.equal(replacement, -1, "Rejected packages must not remove the installed app");
        assert.ok(!calls.some(line => line.startsWith("cp ")));
      } else {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        for (const prefix of ["codesign --verify"]) {
          const index = calls.findIndex(line => line.startsWith(prefix));
          assert.ok(index >= 0 && index < replacement, `${prefix} must precede replacement`);
        }
        assert.ok(calls.some(line => line.startsWith("cp -R ")));
        assert.match(result.stdout, /ad-hoc signed and not notarized/);
        assert.match(result.stdout, /Privacy & Security > Open Anyway/);
      }
      if (rejection !== "checksum") assert.ok(calls.some(line => line.startsWith("hdiutil detach ")), "Always detach the test image, including on rejection");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
