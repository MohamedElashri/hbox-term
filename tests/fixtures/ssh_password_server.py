"""Disposable loopback SSH server for password authentication tests.

No system accounts, user SSH config, authorized keys or known_hosts are read.
"""
import socket
import sys
import threading
import time

import paramiko

MODE = sys.argv[1]
PASSWORD = " fixture SSH password "
KEY = paramiko.RSAKey.generate(2048)


class Server(paramiko.ServerInterface):
    def get_allowed_auths(self, username):
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
            channel.send(b"fixture-ok\n")
            channel.send_exit_status(0)
            channel.shutdown_write()
        threading.Thread(target=reply, daemon=True).start()
        return True


def serve(client):
    transport = paramiko.Transport(client)
    try:
        transport.add_server_key(KEY)
        transport.start_server(server=Server())
        while transport.is_active():
            time.sleep(0.01)
    except (EOFError, OSError, paramiko.SSHException):
        pass
    finally:
        transport.close()


with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    print(listener.getsockname()[1], flush=True)
    while True:
        client, _ = listener.accept()
        threading.Thread(target=serve, args=(client,), daemon=True).start()
