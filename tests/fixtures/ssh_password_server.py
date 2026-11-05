"""Disposable loopback SSH server for password authentication tests.

No system accounts, user SSH config, authorized keys or known_hosts are read.
"""
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
        threading.Thread(target=serve, args=(client,), daemon=True).start()
