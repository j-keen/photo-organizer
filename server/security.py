"""Request gatekeeping (pure ASGI middleware, so streamed responses pass through untouched).

1. Host header must be 127.0.0.1:<port> or localhost:<port> (DNS-rebinding defence) — for every request.
2. /api/health: no session, CORS "*" (a page opened from file:// may detect the server).
3. /api/session: the route itself checks Sec-Fetch-Site (same-origin | none) before issuing the cookie.
4. Every other /api/* call needs the fi_session cookie; mutating methods also need "X-FI-Client: 1"
   (forces a CORS preflight, which we never approve) and, when an Origin header is sent, our own origin.
5. Hardening headers on every response (nosniff, no-referrer, frame-ancestors none, CORP same-origin on /api).
"""
from __future__ import annotations

import json
import secrets
from http.cookies import SimpleCookie

COOKIE_NAME = 'fi_session'
SAFE_METHODS = {'GET', 'HEAD'}
OPEN_PATHS = {'/api/health'}


class SessionManager:
    """One random token per server process; stored in an HttpOnly, SameSite=Strict cookie."""

    def __init__(self) -> None:
        self.token = secrets.token_urlsafe(32)

    def cookie_header(self) -> str:
        return f'{COOKIE_NAME}={self.token}; HttpOnly; SameSite=Strict; Path=/'

    def valid(self, cookie_header: str | None) -> bool:
        if not cookie_header:
            return False
        try:
            jar = SimpleCookie()
            jar.load(cookie_header)
        except Exception:
            # Fall back to a tolerant manual parse (other apps on 127.0.0.1 may set odd cookies)
            for part in cookie_header.split(';'):
                k, _, v = part.strip().partition('=')
                if k == COOKIE_NAME and secrets.compare_digest(v, self.token):
                    return True
            return False
        morsel = jar.get(COOKIE_NAME)
        return bool(morsel) and secrets.compare_digest(morsel.value, self.token)


def _json_response(status: int, code: str, message: str, extra_headers: list[tuple[bytes, bytes]] | None = None):
    body = json.dumps({'error': {'code': code, 'message': message}}, ensure_ascii=False).encode('utf-8')
    headers = [
        (b'content-type', b'application/json; charset=utf-8'),
        (b'content-length', str(len(body)).encode()),
        (b'cache-control', b'no-store'),
    ]
    if extra_headers:
        headers.extend(extra_headers)
    return status, headers, body


class SecurityMiddleware:
    def __init__(self, app, *, port: int, session: SessionManager) -> None:
        self.app = app
        self.port = port
        self.session = session
        self.allowed_hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        self.allowed_origins = {f'http://127.0.0.1:{port}', f'http://localhost:{port}'}

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'lifespan':
            await self.app(scope, receive, send)
            return
        if scope['type'] != 'http':
            # No websockets here
            if scope['type'] == 'websocket':
                await send({'type': 'websocket.close', 'code': 1008})
            return

        headers = {}
        for k, v in scope.get('headers') or []:
            headers[k.decode('latin-1').lower()] = v.decode('latin-1')
        path = scope.get('path', '')
        method = scope.get('method', 'GET').upper()
        is_api = path.startswith('/api/')

        host = headers.get('host', '').lower()
        if host not in self.allowed_hosts:
            await self._reject(send, 403, 'EPERM', '허용되지 않은 주소로 들어온 요청이에요. http://127.0.0.1:%d/ 로 열어 주세요' % self.port)
            return

        cors = False
        if is_api:
            if path in OPEN_PATHS:
                cors = True
                if method == 'OPTIONS':
                    await self._send(send, 204, [
                        (b'access-control-allow-origin', b'*'),
                        (b'access-control-allow-methods', b'GET'),
                        (b'access-control-max-age', b'600'),
                        (b'content-length', b'0'),
                    ], b'')
                    return
            elif method == 'OPTIONS':
                # Never approve a preflight: cross-origin pages can't call the API.
                await self._reject(send, 403, 'EPERM', '다른 사이트에서 온 요청은 받을 수 없어요')
                return
            elif path != '/api/session':
                if not self.session.valid(headers.get('cookie')):
                    await self._reject(send, 401, 'ESESSION', '서버 세션이 만료됐어요. 페이지를 새로 고쳐 주세요')
                    return
                if method not in SAFE_METHODS:
                    if headers.get('x-fi-client') != '1':
                        await self._reject(send, 403, 'EPERM', '앱에서 보낸 요청이 아니라서 거절했어요')
                        return
                    origin = headers.get('origin')
                    if origin and origin.lower() not in self.allowed_origins:
                        await self._reject(send, 403, 'EPERM', '다른 사이트에서 온 요청은 받을 수 없어요')
                        return

        extra = [
            (b'x-content-type-options', b'nosniff'),
            (b'referrer-policy', b'no-referrer'),
            (b'x-frame-options', b'DENY'),
            (b'content-security-policy', b"frame-ancestors 'none'"),
        ]
        if cors:
            extra.append((b'access-control-allow-origin', b'*'))
        elif is_api:
            extra.append((b'cross-origin-resource-policy', b'same-origin'))

        async def send_wrapper(message):
            if message['type'] == 'http.response.start':
                existing = {k.lower() for k, _ in message.get('headers', [])}
                message.setdefault('headers', [])
                message['headers'] = list(message['headers']) + [(k, v) for k, v in extra if k not in existing]
            await send(message)

        await self.app(scope, receive, send_wrapper)

    async def _reject(self, send, status: int, code: str, message: str):
        status, headers, body = _json_response(status, code, message)
        await self._send(send, status, headers + [(b'x-content-type-options', b'nosniff')], body)

    @staticmethod
    async def _send(send, status: int, headers, body: bytes):
        await send({'type': 'http.response.start', 'status': status, 'headers': headers})
        await send({'type': 'http.response.body', 'body': body})
