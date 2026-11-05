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
            handle = paramiko.SFTPHandle(flags)
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
        if MODE == "password" and username == "qa" and password == PASSWORD:
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

    def check_channel_exec_request(self, channel, command):
        def reply():
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
