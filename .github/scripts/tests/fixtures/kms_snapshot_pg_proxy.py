"""Observe actual local PostgreSQL simple-query transport without storing SQL."""

import socket
import socketserver
import struct
import threading
import time


def read_exact(connection, length):
    data = bytearray()
    while len(data) < length:
        part = connection.recv(length - len(data))
        if not part:
            return None
        data.extend(part)
    return bytes(data)


class PgQueryProxy:
    def __init__(self, socket_directory, request_delay=0):
        self.chunk_counts = []
        self.query_count = 0
        self.request_delay = request_delay
        self.errors = []
        observer = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                with socket.socket(socket.AF_UNIX) as backend:
                    backend.connect(str(socket_directory / ".s.PGSQL.5432"))

                    def receive():
                        try:
                            while data := backend.recv(65536):
                                self.request.sendall(data)
                        except OSError:
                            # psql may close immediately after its final result.
                            pass

                    response = threading.Thread(target=receive)
                    try:
                        size = read_exact(self.request, 4)
                        if size is None:
                            return
                        startup = read_exact(
                            self.request, struct.unpack("!I", size)[0] - 4
                        )
                        backend.sendall(size + startup)
                        response.start()
                        while kind := read_exact(self.request, 1):
                            size = read_exact(self.request, 4)
                            payload = read_exact(
                                self.request, struct.unpack("!I", size)[0] - 4
                            )
                            if kind == b"Q":
                                observer.query_count += 1
                                # Generated scan commands start with SELECT; the
                                # WITH query that builds them must not be counted.
                                if payload.lstrip().startswith(
                                    b"SELECT json_build_object"
                                ):
                                    count = payload.count(b"'table-chunk'")
                                    if count:
                                        observer.chunk_counts.append(count)
                                if observer.request_delay:
                                    time.sleep(observer.request_delay)
                            backend.sendall(kind + size + payload)
                    except (OSError, TypeError, struct.error) as error:
                        observer.errors.append(type(error).__name__)
                    finally:
                        backend.shutdown(socket.SHUT_RDWR)
                        if response.ident is not None:
                            response.join(timeout=5)

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = False
        self.thread = threading.Thread(target=self.server.serve_forever)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    @property
    def environment(self):
        return {
            "PGHOST": "127.0.0.1",
            "PGPORT": str(self.server.server_address[1]),
            "PGSSLMODE": "disable",
            "PGGSSENCMODE": "disable",
        }
