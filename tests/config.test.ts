import assert from "node:assert/strict";
import { test } from "node:test";
import { fontSizePx, hostMatches, keybindLines, parseColor, parseConfig, parseDuration, scrollbackLines, themeName, xtermTheme, type ConfigEntry } from "../src/app/config.ts";

const entries = (text: string): ConfigEntry[] => text.trim().split("\n").map((line, index) => {
  const [key, ...rest] = line.split("=");
  // Like src-tauri/src/config.rs: trim, then drop surrounding quotes.
  const value = rest.join("=").trim().replace(/^"(.*)"$/, "$1");
  return { file: "config", line: index + 1, key: key.trim(), value };
});

// The user's actual Ghostty config, abridged.
const ghostty = entries(`
title = Terminal
shell-integration = zsh
scrollback-limit = 4294967295
wait-after-command = true
palette = 0=#21222c
palette = 13=#ff92df
background = 282a36
foreground = f8f8f2
cursor-color = f8f8f2
selection-background = 44475a
cursor-color = #bbbbbb
cursor-style = "block"
cursor-style-blink = false
font-size = 12
copy-on-select = false
clipboard-trim-trailing-spaces = true
keybind = ctrl+shift+x=close_surface
`);

test("reads the user's Ghostty config", () => {
  const { config, ignored, errors } = parseConfig(ghostty);
  assert.deepEqual(errors, []);
  assert.equal(config.fontSize, 12);
  assert.equal(config.colors.background, "#282a36");
  assert.equal(config.colors.cursor, "#bbbbbb", "later cursor-color wins");
  assert.equal(config.colors.palette[13], "#ff92df");
  assert.equal(config.cursorBlink, false);
  assert.equal(config.copyOnSelect, "false");
  assert.equal(config.waitAfterCommand, true);
  assert.deepEqual(config.keybinds, ["ctrl+shift+x=close_surface"]);
  assert.equal(config.shellIntegration, "zsh");
  assert.deepEqual(ignored.map((item) => item.split(" ")[0]), ["title"]);
});

test("reports invalid values without failing", () => {
  const { config, errors } = parseConfig(entries("font-size = huge\nbackground = nope\ncursor-style = blink"));
  assert.equal(config.fontSize, 13);
  assert.equal(errors.length, 3);
});

test("colors accept Ghostty spellings", () => {
  assert.equal(parseColor("282A36"), "#282a36");
  assert.equal(parseColor("#fff"), "#ffffff");
  assert.equal(parseColor("black"), "#000000");
  assert.equal(parseColor("bogus"), null);
});

test("theme layers apply in order, palette maps to xterm names", () => {
  const theme = xtermTheme({ background: "#000000", red: "#aa0000" },
    { background: "#111111", palette: { 1: "#ff5555", 20: "#123456" } },
    { palette: { 1: "#ff0000" } });
  assert.equal(theme.background, "#111111");
  assert.equal(theme.red, "#ff0000");
  assert.equal(theme.extendedAnsi?.[4], "#123456");
});

test("light and dark theme variants", () => {
  assert.equal(themeName("light:Alucard,dark:Dracula", true), "Dracula");
  assert.equal(themeName("light:Alucard,dark:Dracula", false), "Alucard");
  assert.equal(themeName("Dracula", false), "Dracula");
});

test("units", () => {
  assert.equal(fontSizePx(12, "linux"), 16);
  assert.equal(fontSizePx(13, "macos"), 13);
  assert.equal(scrollbackLines(10_000_000), 100_000);
  assert.equal(scrollbackLines(4294967295), 100_000);
  assert.equal(scrollbackLines(0), 1_000);
});

test("keybind = clear drops the defaults", () => {
  assert.deepEqual(keybindLines(["a=b"], ["x=y"]), ["a=b", "x=y"]);
  assert.deepEqual(keybindLines(["a=b"], ["x=y", "clear", "z=w"]), ["z=w"]);
});

test("profile keys", () => {
  const { config, errors } = parseConfig(entries(`
command = /usr/bin/fish -l
working-directory = ~/work
env = EDITOR=nvim
env = FOO=1
env = FOO=
match-host = prod-*
notify-on-command-finish = unfocused
notify-on-command-finish-after = 1m30s
`));
  assert.deepEqual(errors, []);
  assert.equal(config.command, "/usr/bin/fish -l");
  assert.equal(config.workingDirectory, "~/work");
  assert.deepEqual(config.env, [["EDITOR", "nvim"]]);
  assert.deepEqual(config.matchHost, ["prod-*"]);
  assert.equal(config.notifyOnCommandFinish, "unfocused");
  assert.equal(config.notifyOnCommandFinishAfter, 90);
});

test("durations", () => {
  assert.equal(parseDuration("5s"), 5);
  assert.equal(parseDuration("500ms"), 0.5);
  assert.equal(parseDuration("2"), 2);
  assert.equal(parseDuration("soon"), null);
});

test("host globs", () => {
  assert.ok(hostMatches(["prod-*"], "PROD-db1"));
  assert.ok(hostMatches(["*.example.com"], "api.example.com"));
  assert.ok(!hostMatches(["*.example.com"], "example.com.evil"));
  assert.ok(hostMatches(["10.0.0.?"], "10.0.0.7"));
  assert.ok(!hostMatches([], "anything"));
});

test("OSC 7 directory reports", async () => {
  const { parseDirectoryReport } = await import("../src/app/shell-integration.ts");
  assert.deepEqual(parseDirectoryReport("file://box/home/me/my%20dir"), { host: "box", path: "/home/me/my dir" });
  assert.deepEqual(parseDirectoryReport("file:///tmp"), { host: "", path: "/tmp" });
  assert.equal(parseDirectoryReport("file://box/bad%E0%A4%A"), null);
  assert.equal(parseDirectoryReport("http://x/y"), null);
});

test("triggers from the config, invalid ones reported", () => {
  const { config, errors } = parseConfig(entries("trigger = highlight:#ff5555 /error/i\ntrigger = explode /x/\nimage-storage-limit = 0"));
  assert.equal(config.triggers.length, 1);
  assert.equal(config.triggers[0].action, "highlight");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown trigger action/);
  assert.equal(config.imageStorageLimit, 0);
});

test("remote shell integration is opt-in", () => {
  assert.equal(parseConfig([]).config.remoteShellIntegration, false);
  assert.equal(parseConfig(entries("remote-shell-integration = true")).config.remoteShellIntegration, true);
});
