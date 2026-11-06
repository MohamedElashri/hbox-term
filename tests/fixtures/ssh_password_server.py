"""Disposable loopback SSH server for password authentication tests.

No system accounts, user SSH config, authorized keys or known_hosts are read.
"""
import os
import socket
from pathlib import Path
import sys
import threading
import time

import paramiko

MODE = sys.argv[1]
PASSWORD = " fixture SSH password "
KEY = paramiko.RSAKey.generate(2048)
STATE = Path(sys.argv[2]) if len(sys.argv) > 2 else None

# Representative Linux output over a real authenticated SSH transport. No remote
# shell commands are executed by this disposable fixture.
OVERVIEW = b"""__TERNWAY_OVERVIEW_V1__profile
hostname\tfixture-linux
kernel\tfixture-kernel
__TERNWAY_OVERVIEW_V1__capabilities
distro\tUbuntu fixture
architecture\tx86_64
root\tfalse
command\tss
command\tcrontab
command\tsystemctl
command\tdocker
command\tjournalctl
packageManager\tapt-get
__TERNWAY_OVERVIEW_V1__cpu
before\t10 0 10 80 0 0 0 0
after\t20 0 20 160 0 0 0 0
cores\t2
model\tFixture CPU
__TERNWAY_OVERVIEW_V1__memory
MemTotal: 1024000 kB
MemAvailable: 256000 kB
SwapTotal: 0 kB
SwapFree: 0 kB
__TERNWAY_OVERVIEW_V1__storage
Filesystem 1024-blocks Used Available Capacity Mounted on
tmpfs 1024 32 992 4% /run
/dev/root 1000000 250000 750000 25% /
__TERNWAY_OVERVIEW_V1__uptime
3600
0.1 0.2 0.3 1/100 1
__TERNWAY_OVERVIEW_V1__network
2: eth0 inet 192.0.2.10/24 scope global eth0
"""


def feature_output(command, script):
    """Representative read-only tool responses; never execute an incoming command."""
    if b"__TERNWAY_OVERVIEW_V1__" in script:
        return OVERVIEW
    if command.startswith(b"printf 'distro\\t'; os_release="):
        return OVERVIEW.split(b'__TERNWAY_OVERVIEW_V1__capabilities\n')[1].split(b'__TERNWAY_OVERVIEW_V1__cpu')[0]
    if b"__TERNWAY_DISK_V1__" in script:
        return b"__TERNWAY_DISK_V1__mounts\nFilesystem Blocks Used Available Use% Mounted on\n/dev/root 1000000 250000 750000 25% /\n__TERNWAY_DISK_V1__inodes\ninode\t/dev/root\t1000\t100\t10%\t/\n__TERNWAY_DISK_V1__largest_files\n4096\t1\t/var/log/fixture.log\n__TERNWAY_DISK_V1__largest_dirs\n10240\t/var/log\n__TERNWAY_DISK_V1__docker_usage\n"
    if b"__TERNWAY_DOCKER_ITEMS_V1__" in script:
        kind = next((name for name in [b'containers', b'images', b'volumes', b'networks'] if b"'" + name + b"'" in command), None)
        rows = {
            b'containers': b'{"ID":"abc123","Names":"fixture-web","Image":"nginx:fixture","State":"running","Status":"Up 1 hour","Ports":"8080/tcp"}',
            b'images': b'{"ID":"image123","Repository":"nginx","Tag":"fixture","Size":"10MB"}',
            b'volumes': b'{"Name":"fixture-data","Driver":"local"}',
            b'networks': b'{"ID":"net123","Name":"fixture-net","Driver":"bridge","Scope":"local"}',
        }
        stats = b'{"ID":"abc123","Name":"fixture-web","CPUPerc":"2.5%","MemUsage":"1MiB / 10MiB","MemPerc":"10%","NetIO":"2kB / 3kB","BlockIO":"0B / 0B"}' if kind == b'containers' else b''
        if kind in rows:
            return b'__TERNWAY_DOCKER_ITEMS_V1__\n' + rows[kind] + b'\n__TERNWAY_DOCKER_STATS_V1__\n' + stats + b'\n'
    if command.startswith(b'if ps -eo '):
        return b'ternway-eo\n42 qa 2.5 1.0 1024 60 /usr/bin/fixture --label two words\n'
    if command.startswith(b'systemctl list-units '):
        return 'fixture.service loaded active running Fixture service\n\u25cf failed.service loaded failed failed Failed fixture\n'.encode()
    if command.startswith(b'for unit in '):
        return b'fixture.service\tenabled\nfailed.service\tdisabled\n'
    if command.startswith(b'systemctl show '):
        return b'/etc/systemd/system/fixture.service\n' if b'-p FragmentPath' in command else b'Description=Fixture service\nActiveState=active\nMainPID=42\n'
    if command.startswith(b'journalctl '):
        return b'2026-11-06T12:00:00+0000 fixture service started\n'
    if command.startswith(b'crontab -l '):
        return b'MAILTO = "fixture@example.invalid"\n@reboot printf "two  spaces"\n'
    if command.startswith(b'for f in /etc/crontab '):
        return b'/etc/cron.d/fixture\t@daily root printf "system  fixture"\n'
    if command.startswith(b'LC_ALL=C apt list '):
        return b'Listing...\nfixture/stable 2.0 amd64 [upgradable from: 1.0]\n'
    if command.startswith(b'dpkg-query -W '):
        return b'fixture:amd64\t1.0\tamd64\tFixture package\nfixture:i386\t1.0\ti386\tOther architecture\n' if b'Summary' in command else b'fixture:amd64\nfixture:i386\n'
    if command.startswith(b'apt-cache search '):
        return b'fixture - Fixture package\n'
    if command.startswith(b'apt-cache show '):
        return b'Package: fixture\nVersion: 1.0\n'
    if command.startswith(b'ss -H '):
        return b'tcp LISTEN 0 128 [::]:239 [::]:* users:(("sshd",pid=42,fd=3))\n'
    if command.startswith(b'if command -v getent '):
        if b'getent passwd' in command:
            return b'qa:x:1000:1000:Fixture:/home/qa:/bin/sh\n'
        if b'getent group' in command:
            return b'qa:x:1000:\noperators:x:1001:qa\n'
        if b'getent shadow' in command:
            return b'qa:!:19000:0:99999:7:::\n'
    if command == b'id -u':
        return b'0\n'  # Only the fixture simulates privilege; no system account is used.
    if command.startswith(b'LC_ALL=C lastlog '):
        return b'Username Port From Latest\nqa pts/0 fixture Fri Nov 6 12:00:00 +0000 2026\n'
    if command == b'docker info >/dev/null':
        return b''
    return None


class SftpServer(paramiko.SFTPServer):
    def _send_server_version(self):
        kind, data = self._read_packet()
        if kind != 1:
            raise paramiko.SFTPError("Expected SFTP INIT")
        message = paramiko.Message()
        message.add_int(3)
        message.add_string("posix-rename@openssh.com")
        message.add_string("1")
        self._send_packet(2, message)
        return 3


class SlowUploadHandle(paramiko.SFTPHandle):
    def write(self, offset, data):
        time.sleep(0.02)
        return super().write(offset, data)


class Files(paramiko.SFTPServerInterface):
    def local(self, path):
        root = (STATE / "files").resolve()
        root.mkdir(exist_ok=True)
        result = (root / path.lstrip("/")).resolve()
        if not result.is_relative_to(root):
            raise PermissionError("Outside fixture")
        return result

    def _call(self, operation):
        try:
            return operation()
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno or 13)

    def list_folder(self, path):
        def listing():
            entries = []
            for entry in self.local(path).iterdir():
                attrs = paramiko.SFTPAttributes.from_stat(entry.lstat())
                attrs.filename = entry.name
                entries.append(attrs)
            return entries
        return self._call(listing)

    def stat(self, path):
        return self._call(lambda: paramiko.SFTPAttributes.from_stat(self.local(path).stat()))

    def lstat(self, path):
        return self._call(lambda: paramiko.SFTPAttributes.from_stat(self.local(path).lstat()))

    def open(self, path, flags, attr):
        def opened():
            fd = os.open(self.local(path), flags, attr.st_mode or 0o600)
            file = os.fdopen(fd, "r+b" if flags & os.O_RDWR else "wb" if flags & os.O_WRONLY else "rb")
            handle = SlowUploadHandle(flags) if MODE == 'features' and 'fixture-upload.bin' in path else paramiko.SFTPHandle(flags)
            handle.readfile = file
            handle.writefile = file
            return handle
        return self._call(opened)

    def remove(self, path):
        return self._call(lambda: (self.local(path).unlink(), paramiko.SFTP_OK)[1])

    def mkdir(self, path, attr):
        return self._call(lambda: (self.local(path).mkdir(mode=attr.st_mode or 0o755), paramiko.SFTP_OK)[1])

    def rmdir(self, path):
        return self._call(lambda: (self.local(path).rmdir(), paramiko.SFTP_OK)[1])

    def rename(self, old, new):
        if self.local(new).exists():
            return paramiko.SFTP_FAILURE
        return self.posix_rename(old, new)

    def posix_rename(self, old, new):
        if str(new).endswith("rename-denied"):
            return paramiko.SFTP_PERMISSION_DENIED
        return self._call(lambda: (os.replace(self.local(old), self.local(new)), paramiko.SFTP_OK)[1])

    def chattr(self, path, attr):
        return self._call(lambda: (paramiko.SFTPServer.set_file_attr(str(self.local(path)), attr), paramiko.SFTP_OK)[1])


class Server(paramiko.ServerInterface):
    def __init__(self):
        self.forwards = {}

    def check_auth_publickey(self, username, key):
        accepted = MODE == "publickey" and username == "qa" and STATE is not None and key.get_base64() == (STATE / "client.pub").read_text().split()[1]
        if STATE is not None:
            with (STATE / "auth.log").open("a") as log:
                log.write("accepted\n" if accepted else "rejected\n")
        return paramiko.AUTH_SUCCESSFUL if accepted else paramiko.AUTH_FAILED

    def check_channel_pty_request(self, channel, term, width, height, pixelwidth, pixelheight, modes):
        return True

    def check_channel_window_change_request(self, channel, width, height, pixelwidth, pixelheight):
        threading.Thread(target=channel.send, args=(f"fixture-resized:{width}x{height}\n".encode(),), daemon=True).start()
        return True

    def check_channel_direct_tcpip_request(self, channel_id, origin, destination):
        if destination[0] != "127.0.0.1":
            return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        self.forwards[channel_id] = destination
        return paramiko.OPEN_SUCCEEDED

    def get_allowed_auths(self, username):
        if MODE == "publickey":
            return "publickey"
        return "keyboard-interactive" if MODE == "keyboard" else "password,keyboard-interactive"

    def check_auth_password(self, username, password):
        if MODE in {"password", "features"} and username == "qa" and password == PASSWORD:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_auth_interactive(self, username, submethods):
        if username != "qa":
            return paramiko.AUTH_FAILED
        return paramiko.InteractiveQuery("Login", "", ("Password: ", False))

    def check_auth_interactive_response(self, responses):
        return paramiko.AUTH_SUCCESSFUL if responses == [PASSWORD] else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_shell_request(self, channel):
        if MODE != 'features':
            return False

        def echo():
            # A disposable interactive SSH channel, not a real command shell.
            # Echo complete lines and let the native UI exercise reconnect.
            try:
                channel.sendall(b'fixture-terminal-ready\r\n$ ')
                pending = b''
                while data := channel.recv(4096):
                    pending += data
                    while b'\r' in pending or b'\n' in pending:
                        end = min(index for index, byte in enumerate(pending) if byte in (10, 13))
                        line, pending = pending[:end], pending[end + 1:].lstrip(b'\r\n')
                        if line == b'exit':
                            channel.send_exit_status(0)
                            channel.shutdown_write()
                            time.sleep(0.05)
                            return
                        channel.sendall(line + b'\r\n$ ')
            except (EOFError, OSError, paramiko.SSHException):
                pass
            finally:
                channel.close()

        threading.Thread(target=echo, daemon=True).start()
        return True

    def check_channel_exec_request(self, channel, command):
        def reply():
            if MODE == "features":
                script = b""
                if command.startswith(b"LC_ALL=C sh -s"):
                    while chunk := channel.recv(65536):
                        script += chunk
                        if len(script) > 262144:
                            channel.close()
                            return
                output = feature_output(command, script)
                if output is not None:
                    channel.sendall(output)
                else:
                    channel.send_stderr(b"Unsupported command in isolated feature fixture\n")
                    channel.send_exit_status(1)
                    channel.close()
                    return
                channel.send_exit_status(0)
                channel.shutdown_write()
                time.sleep(0.05)
                channel.close()
                return
            if command == b"fixture-wait":
                channel.send(b"fixture-ready\n")
                return
            channel.send(b"fixture-command:" + command + b"\n" if MODE == "publickey" else b"fixture-ok\n")
            channel.send_exit_status(0)
            channel.shutdown_write()
            # The request handler must return its success before the exec channel closes.
            time.sleep(0.05)
            channel.close()
        threading.Thread(target=reply, daemon=True).start()
        return True


def forward(channel, destination):
    peer = socket.create_connection(destination, timeout=5)
    def copy(source, target):
        try:
            while data := source.recv(65536):
                target.sendall(data)
        except (EOFError, OSError):
            pass
        finally:
            try:
                target.shutdown_write() if isinstance(target, paramiko.Channel) else target.shutdown(socket.SHUT_WR)
            except (EOFError, OSError):
                pass
    other = threading.Thread(target=copy, args=(peer, channel), daemon=True)
    other.start()
    copy(channel, peer)
    other.join(timeout=5)
    peer.close()
    channel.close()


def serve(client):
    transport = paramiko.Transport(client)
    channels = []
    try:
        transport.add_server_key(KEY)
        transport.set_subsystem_handler("sftp", SftpServer, Files)
        server = Server()
        transport.start_server(server=server)
        while transport.is_active():
            channel = transport.accept(0.1)
            if channel is not None:
                if channel.get_id() in server.forwards:
                    threading.Thread(target=forward, args=(channel, server.forwards[channel.get_id()]), daemon=True).start()
                else:
                    channels.append(channel)
            channels = [channel for channel in channels if not channel.closed]
    except (EOFError, OSError, paramiko.SSHException):
        pass
    finally:
        transport.close()


with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    if STATE is not None:
        (STATE / "known_hosts").write_text(f"[127.0.0.1]:{port} {KEY.get_name()} {KEY.get_base64()}\n")
    print(port, flush=True)
    while True:
        client, _ = listener.accept()
        if STATE is not None:
            with (STATE / "connections.log").open("a") as log:
                log.write("connection\n")
        threading.Thread(target=serve, args=(client,), daemon=True).start()
