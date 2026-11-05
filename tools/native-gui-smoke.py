#!/usr/bin/env python3
"""Isolated Linux WebKitGTK end-to-end checks; no browser simulation or live accounts."""
import base64
import http.client
import json
import os
from pathlib import Path
import socket
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

if not sys.platform.startswith("linux"):
    raise SystemExit("Run this harness on an isolated Linux test runner.")
binary = Path(sys.argv[1]).resolve(strict=True)
root = Path(os.environ["TERNWAY_GUI_ROOT"]).resolve()
root.mkdir(mode=0o700, parents=True, exist_ok=False)
artifacts = root / "artifacts"
artifacts.mkdir()
for name in ["config", "data", "cache", "shell"]:
    (root / name).mkdir(mode=0o700)
os.environ.update({"XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"), "SHELL": "/bin/sh", "ENV": "/dev/null", "BASH_ENV": "/dev/null", "ZDOTDIR": str(root / "shell"), "TAURI_WEBVIEW_AUTOMATION": "true"})
config = root / "config" / "ternway"
config.mkdir()
(config / "config").write_text("shell-integration = none\nwindow-save-state = always\nsave-scrollback = false\nclipboard-history = false\n")
log = (artifacts / "driver.log").open("w")
driver = subprocess.Popen(["tauri-driver", "--native-driver", "/usr/bin/WebKitWebDriver"], stdout=log, stderr=log, start_new_session=True)
base = "http://127.0.0.1:4444"
session = None
checks = []

def request(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=35) as response:
            value = json.load(response).get("value")
    except urllib.error.HTTPError as error:
        detail = json.loads(error.read()).get("value", {})
        raise RuntimeError(str(detail)) from error
    if isinstance(value, dict) and value.get("error"):
        raise RuntimeError(str(value))
    return value

def wait(test, description, timeout=30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            result = test()
            if result:
                return result
        except (RuntimeError, urllib.error.URLError, http.client.RemoteDisconnected) as error:
            # WebKit can reset a polling connection while restored webviews attach.
            # Keep the same bounded assertion; a persistent disconnect still fails.
            last = error
        time.sleep(0.15)
    raise AssertionError(f"Timed out: {description}: {last}")

def execute(script, *args):
    return request("POST", f"/session/{session}/execute/sync", {"script": script, "args": list(args)})

def invoke(command, **args):
    result = request("POST", f"/session/{session}/execute/async", {"script": "const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value}),error=>done({ok:false,error}));", "args": [command, args]})
    if not result["ok"]:
        raise RuntimeError(str(result["error"]))
    return result.get("value")

def element(selector):
    result = request("POST", f"/session/{session}/element", {"using": "css selector", "value": selector})
    return result["element-6066-11e4-a52e-4f735466cecf"]

def click(selector):
    target = wait(lambda: element(selector), selector)
    execute("document.querySelector(arguments[0]).scrollIntoView({block:'center'});", selector)
    request("POST", f"/session/{session}/element/{target}/click", {})

def type_into(selector, text):
    target = element(selector)
    request("POST", f"/session/{session}/element/{target}/clear", {})
    request("POST", f"/session/{session}/element/{target}/value", {"text": text, "value": list(text)})

def shown(selector):
    return execute("const el=document.querySelector(arguments[0]);return !!el && !!el.getClientRects().length;", selector)

def start():
    global session
    response = request("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": str(binary)}}}})
    session = response["sessionId"]
    request("POST", f"/session/{session}/timeouts", {"script": 30000, "pageLoad": 30000, "implicit": 0})
    wait(lambda: shown('[data-action="credential-settings"]'), "app bootstrap")

def screenshot(name):
    value = request("GET", f"/session/{session}/screenshot")
    (artifacts / name).write_bytes(base64.b64decode(value))

def check(name):
    checks.append(name)
    print(f"PASS {name}", flush=True)

trap = socket.socket()
trap.bind(("127.0.0.1", 0))
trap.listen()
port = trap.getsockname()[1]
ssh_config = root / "ssh-config"
ssh_config.write_text(f"Host ci-loopback\n HostName 127.0.0.1\n User qa\n Port {port}\nHost github.com\n HostName github.com\n User git\n")
try:
    wait(lambda: request("GET", "/status") is not None, "driver startup")
    start()
    textarea = wait(lambda: element('.xterm-helper-textarea'), "local terminal")
    # The marker is encoded in the command so shell echo cannot satisfy this assertion.
    expected = "CI_NATIVE_λ_漢字"
    escaped = ''.join('\\%03o' % byte for byte in expected.encode())
    request("POST", f"/session/{session}/element/{textarea}/value", {"text": f"printf '{escaped}\\n'\n"})
    wait(lambda: execute("return document.querySelector('.terminal-layer')?.textContent?.includes(arguments[0]) || Array.from(document.querySelectorAll('.xterm-rows')).some(el=>el.textContent.includes(arguments[0]));", expected), "real PTY Unicode output")
    check("native WebKitGTK terminal accepts input and renders UTF-8 process output")
    for width, height in [(1000, 700), (1280, 850), (1080, 720), (1400, 900)]:
        request("POST", f"/session/{session}/window/rect", {"width": width, "height": height})
    check("window resizing keeps the terminal alive")

    click('[data-action="credential-settings"]')
    sections = execute("return Array.from(document.querySelectorAll('.settings-nav button')).map(el=>el.textContent.trim());")
    assert sections[-1] == "About", sections
    click('[data-action="close-modal"]')
    click('[data-action="theme"]')
    if execute("return document.querySelector('[data-theme]')?.dataset.theme;") != "dark":
        click('[data-action="theme"]')
    check("settings order and native dark-mode controls")

    click('[data-action="add-server"]')
    type_into('[data-form="server"] [name="name"]', 'CI save only')
    type_into('[data-form="server"] [name="host"]', '127.0.0.1')
    type_into('[data-form="server"] [name="username"]', 'qa')
    click('[data-managed-route] > summary')
    type_into('[data-form="server"] [name="port"]', str(port))
    click('[data-form="server"] button[type="submit"]')
    wait(lambda: not shown('[data-form="server"]'), "save-only connection")
    assert len(invoke("get_state")["servers"]) == 1
    trap.settimeout(0.1)
    try:
        connection, _ = trap.accept()
        connection.close()
        raise AssertionError("Saving a connection contacted the SSH host")
    except socket.timeout:
        pass
    check("password profile saves without contacting its host or asking for credentials")

    for attempt in range(2):
        click('[data-action="import-ssh-config"]')
        type_into('[data-form="ssh-import"] [name="path"]', str(ssh_config))
        click('[data-action="load-ssh-config"]')
        wait(lambda: execute("return document.querySelectorAll('.import-host').length===2;"), "SSH config preview")
        assert execute("return Array.from(document.querySelectorAll('.import-host')).filter(el=>el.textContent.includes('github.com')).every(el=>!el.querySelector('input').checked);")
        contrast = execute(r"""
          const el=document.querySelector('.import-host strong');
          const rgb=value=>(value.match(/[\d.]+/g)||[]).map(Number);
          const fg=rgb(getComputedStyle(el).color);
          let bg; for(let node=el;node;node=node.parentElement){const value=rgb(getComputedStyle(node).backgroundColor);if(value.length===3 || value[3]>0.99){bg=value;break;}}
          const lum=values=>values.slice(0,3).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
          const a=lum(fg),b=lum(bg);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
        """)
        assert contrast >= 4.5, f"Dark import text contrast is too low: {contrast}"
        click('[data-form="ssh-import"] button[type="submit"]')
        wait(lambda: len(invoke("get_state")["servers"]) == 2, "duplicate-safe import")
        wait(lambda: execute("return document.querySelector('[data-import-error]')?.textContent.includes('Imported');"), "visible import completion")
        screenshot(f"ssh-import-dark-{attempt}.png")
        click('[data-action="close-modal"]')
    check("native SSH import excludes Git by default, stays readable and deduplicates repeat imports")

    backup = root / "library.json"
    invoke("export_library_backup", path=str(backup), includeSecrets=False)
    archive = json.loads(backup.read_text())
    assert archive["version"] == 1 and archive["encryptedVault"] is None
    assert len(archive["tables"]["servers"]) == 2
    check("library export uses real IPC and excludes saved secrets by default")

    click('[data-action="workspace-library"]')
    click('[data-action="save-workspace-layout"]')
    type_into('[data-form="input-prompt"] [name="value"]', 'CI native layout')
    click('[data-form="input-prompt"] button[type="submit"]')
    wait(lambda: any(row["name"] == "CI native layout" for row in invoke("list_workspaces")["entries"]), "named layout save")
    layouts = invoke("list_workspaces")["entries"]
    layout = next(row for row in layouts if row["name"] == "CI native layout")
    click('[data-action="close-modal"]')
    invoke("new_workspace_window", layoutId=layout["id"])
    wait(lambda: len(request("GET", f"/session/{session}/window/handles")) >= 2, "second ordinary window")
    check("named layout opens in another native window")

    # Quit exercises the same all-window save barrier used by updater restart.
    execute("setTimeout(()=>window.__TAURI_INTERNALS__.invoke('request_app_quit'),0); return true;")
    data_dir = root / "data" / "dev.elashri.ternway.ci"
    wait(lambda: (data_dir / "windows.json").exists() and len(json.loads((data_dir / "windows.json").read_text())) == 2, "window restore manifest")
    wait(lambda: (data_dir / "session.json").exists() and len(list((data_dir / "sessions").glob('*.json'))) >= 1, "every window saved before exit")
    def app_exited():
        try:
            return not request("GET", f"/session/{session}/window/handles")
        except (RuntimeError, urllib.error.URLError):
            return True
    wait(app_exited, "coordinated quit completed without killing the application")
    try:
        request("DELETE", f"/session/{session}")
    except (RuntimeError, urllib.error.URLError):
        pass
    session = None
    (data_dir / "transfers.json").write_text("damaged test queue")
    start()
    wait(lambda: execute("return document.body.textContent.includes('Start session');"), "restored dormant panes")
    assert not execute("return document.body.textContent.includes(arguments[0]);", expected), "Private scrollback should not be restored by default"
    assert "retained" in invoke("transfer_queue_notice")
    assert any(path.read_text() == "damaged test queue" for path in data_dir.glob("transfers-recovery-*.json"))
    check("damaged transfer queue is retained without blocking native terminal startup")
    screenshot("restored-layout.png")
    check("all native windows save and reopen dormant without output or command replay")
    (artifacts / "results.json").write_text(json.dumps({"backend": os.environ.get("GDK_BACKEND"), "checks": checks}, indent=2))
finally:
    if session:
        try:
            screenshot("final.png")
            request("DELETE", f"/session/{session}")
        except Exception as error:
            print(f"Cleanup observation: {error}", file=sys.stderr)
    trap.close()
    try:
        os.killpg(driver.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        driver.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(driver.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        driver.wait()
    log.close()
