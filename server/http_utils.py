"""HTTP helpers: file responses with ETag/304 and single-range (206) support, streamed from share-delete handles."""
from __future__ import annotations

import email.utils
import hashlib
import os
import re
import stat as stat_mod

from fastapi import Request
from fastapi.responses import Response, StreamingResponse

from .config import content_type as guess_type
from .errors import ApiError
from .fsutil import iter_file, mtime_ms, open_shared

_RANGE = re.compile(r'^bytes=(\d*)-(\d*)$')


def etag_for(st: os.stat_result) -> str:
    return f'"{st.st_size:x}-{st.st_mtime_ns:x}"'


def etag_for_bytes(data: bytes) -> str:
    return '"' + hashlib.sha1(data).hexdigest()[:20] + '"'


def etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    if header.strip() == '*':
        return True
    tags = [t.strip() for t in header.split(',')]
    bare = etag.removeprefix('W/')
    return any(t.removeprefix('W/') == bare for t in tags)


def parse_range(header: str | None, size: int) -> tuple[int, int] | None | str:
    """(start, end_inclusive) for a satisfiable single range, None for no/ignored range, 'invalid' for 416."""
    if not header:
        return None
    header = header.strip()
    if ',' in header:
        header = header.split(',', 1)[0].strip()  # multipart ranges: serve the first one
    m = _RANGE.match(header)
    if not m:
        return None
    a, b = m.group(1), m.group(2)
    if a == '' and b == '':
        return None
    if a == '':
        n = int(b)
        if n == 0:
            return 'invalid'
        start = max(0, size - n)
        end = size - 1
    else:
        start = int(a)
        end = int(b) if b else size - 1
        end = min(end, size - 1)
    if size == 0 or start >= size or start > end:
        return 'invalid'
    return start, end


SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'"


def file_response(
    request: Request,
    abs_path: str,
    *,
    media_type: str | None = None,
    cache_control: str = 'no-cache',
    headers: dict | None = None,
    display: str | None = None,
    sandbox: bool = True,
) -> Response:
    """Serve a file with ETag, conditional GET, Range and HEAD support."""
    try:
        st = os.stat(abs_path)
    except FileNotFoundError:
        raise ApiError('ENOENT', f'"{display}" 파일을 찾을 수 없어요' if display else '파일을 찾을 수 없어요')
    if stat_mod.S_ISDIR(st.st_mode):
        raise ApiError('EINVAL', f'"{display}"은(는) 폴더예요' if display else '폴더는 내려받을 수 없어요')
    etag = etag_for(st)
    base_headers = {
        'ETag': etag,
        'Last-Modified': email.utils.formatdate(st.st_mtime, usegmt=True),
        'Accept-Ranges': 'bytes',
        'Cache-Control': cache_control,
        'X-FI-Mtime': str(mtime_ms(st)),
        'X-FI-Size': str(st.st_size),
    }
    if sandbox:
        # User files are data, never documents of this origin: an .html/.svg opened directly runs in an opaque,
        # script-less sandbox (no cookies, no API access). <img>/<video> rendering is unaffected.
        base_headers['Content-Security-Policy'] = SANDBOX_CSP
    if headers:
        base_headers.update(headers)
    ctype = media_type or guess_type(abs_path)

    if etag_matches(request.headers.get('if-none-match'), etag):
        return Response(status_code=304, headers=base_headers)

    size = st.st_size
    rng = parse_range(request.headers.get('range'), size)
    if_range = request.headers.get('if-range')
    if rng is not None and if_range and not etag_matches(if_range, etag):
        rng = None  # resource changed: send the whole thing
    if rng == 'invalid':
        return Response(status_code=416, headers={**base_headers, 'Content-Range': f'bytes */{size}'})

    if rng is None:
        start, length, status = 0, size, 200
    else:
        start, end = rng
        length, status = end - start + 1, 206
        base_headers['Content-Range'] = f'bytes {start}-{end}/{size}'
    base_headers['Content-Length'] = str(length)

    if request.method == 'HEAD':
        return Response(status_code=status, headers=base_headers, media_type=ctype)
    f = open_shared(abs_path)
    return StreamingResponse(iter_file(f, start, length), status_code=status, headers=base_headers, media_type=ctype)


def bytes_response(request: Request, data: bytes, media_type: str, *, cache_control: str = 'no-cache', headers: dict | None = None) -> Response:
    """Small in-memory payload (thumbnails, injected HTML) with ETag/304."""
    etag = etag_for_bytes(data)
    h = {'ETag': etag, 'Cache-Control': cache_control}
    if headers:
        h.update(headers)
    if etag_matches(request.headers.get('if-none-match'), etag):
        return Response(status_code=304, headers=h)
    if request.method == 'HEAD':
        h['Content-Length'] = str(len(data))
        return Response(status_code=200, headers=h, media_type=media_type)
    return Response(content=data, status_code=200, headers=h, media_type=media_type)
