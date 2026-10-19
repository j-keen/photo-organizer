"""Per-workspace SQLite cache: <root>/.fluid-organizer/hashes.sqlite

Tables
  hashes(path, kind, size, mtime, value)   kind: 'blake2b' | 'phash' | 'vhash' | 'prehash' ...
  meta(path, size, mtime, json)            media info (width, height, duration, ...) from thumbs/probe
  fingerprints(path, engine, size, mtime, json)   dupes v2 fingerprints (qhash, fhash, duration, w, h, frames, phash)

External roots (dupes v2) are never written to: their fingerprints go to for_external(app_data_dir), keyed by the
normcase absolute path.

Entries are keyed by workspace-relative path and only valid while size+mtime (ms) still match, so edits,
renames and moves simply produce cache misses.

    cache = mediacache.for_workspace(ws)
    v = cache.get_hash(rel, size, mtime, 'phash');  cache.put_hash(rel, size, mtime, 'phash', b'...')
    m = cache.get_meta(rel, size, mtime);           cache.put_meta(rel, size, mtime, {'width': 640})
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading

from .config import DATA_DIR_NAME

log = logging.getLogger('fi.cache')

_caches: dict[str, 'MediaCache'] = {}
_caches_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS hashes (
    path TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, value BLOB,
    PRIMARY KEY (path, kind)
);
CREATE TABLE IF NOT EXISTS meta (
    path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fingerprints (
    path TEXT NOT NULL, engine TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, json TEXT NOT NULL,
    PRIMARY KEY (path, engine)
);
"""


class MediaCache:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self.broken = False

    def _db(self) -> sqlite3.Connection | None:
        if self._conn is not None or self.broken:
            return self._conn
        try:
            os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
            conn = sqlite3.connect(self.db_path, timeout=10, check_same_thread=False, isolation_level=None)
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA synchronous=NORMAL')
            conn.executescript(SCHEMA)
            self._conn = conn
        except sqlite3.Error as e:
            # Read-only folder or corrupt DB: work without a persistent cache
            log.warning('hash cache unavailable (%s): %s', self.db_path, e)
            self.broken = True
            self._conn = None
        return self._conn

    # ----- hashes -----
    def get_hash(self, path: str, size: int, mtime: int, kind: str) -> bytes | None:
        with self._lock:
            db = self._db()
            if db is None:
                return None
            try:
                row = db.execute('SELECT value FROM hashes WHERE path=? AND kind=? AND size=? AND mtime=?', (path, kind, size, mtime)).fetchone()
            except sqlite3.Error:
                return None
        return row[0] if row else None

    def get_hashes(self, kind: str, items: list[tuple[str, int, int]]) -> dict[str, bytes]:
        """Bulk lookup: {path: value} for items [(path, size, mtime)] that are still valid."""
        out: dict[str, bytes] = {}
        if not items:
            return out
        with self._lock:
            db = self._db()
            if db is None:
                return out
            want = {p: (s, m) for p, s, m in items}
            try:
                for i in range(0, len(items), 500):
                    chunk = [p for p, _, _ in items[i:i + 500]]
                    q = 'SELECT path, size, mtime, value FROM hashes WHERE kind=? AND path IN (%s)' % ','.join('?' * len(chunk))
                    for path, size, mtime, value in db.execute(q, [kind, *chunk]):
                        if want.get(path) == (size, mtime):
                            out[path] = value
            except sqlite3.Error:
                pass
        return out

    def put_hash(self, path: str, size: int, mtime: int, kind: str, value: bytes) -> None:
        self.put_hashes(kind, [(path, size, mtime, value)])

    def put_hashes(self, kind: str, rows: list[tuple[str, int, int, bytes]]) -> None:
        if not rows:
            return
        with self._lock:
            db = self._db()
            if db is None:
                return
            try:
                db.execute('BEGIN')
                db.executemany('INSERT OR REPLACE INTO hashes(path, kind, size, mtime, value) VALUES (?,?,?,?,?)', [(p, kind, s, m, v) for p, s, m, v in rows])
                db.execute('COMMIT')
            except sqlite3.Error as e:
                try:
                    db.execute('ROLLBACK')
                except sqlite3.Error:
                    pass
                log.debug('put_hashes failed: %s', e)

    # ----- media info -----
    def get_meta(self, path: str, size: int, mtime: int) -> dict | None:
        with self._lock:
            db = self._db()
            if db is None:
                return None
            try:
                row = db.execute('SELECT json FROM meta WHERE path=? AND size=? AND mtime=?', (path, size, mtime)).fetchone()
            except sqlite3.Error:
                return None
        if not row:
            return None
        try:
            return json.loads(row[0])
        except ValueError:
            return None

    def put_meta(self, path: str, size: int, mtime: int, meta: dict) -> None:
        with self._lock:
            db = self._db()
            if db is None:
                return
            try:
                db.execute('INSERT OR REPLACE INTO meta(path, size, mtime, json) VALUES (?,?,?,?)', (path, size, mtime, json.dumps(meta, ensure_ascii=False)))
            except sqlite3.Error as e:
                log.debug('put_meta failed: %s', e)

    # ----- duplicate fingerprints (dupes v2): one JSON document per file and engine -----
    def get_fingerprints(self, engine: str, items: list[tuple[str, int, int]]) -> dict[str, dict]:
        """Bulk lookup: {path: fingerprint dict} for items [(path, size, mtime)] whose size+mtime still match."""
        out: dict[str, dict] = {}
        if not items:
            return out
        with self._lock:
            db = self._db()
            if db is None:
                return out
            want = {p: (s, m) for p, s, m in items}
            keys = list(want)
            try:
                for i in range(0, len(keys), 500):
                    chunk = keys[i:i + 500]
                    q = 'SELECT path, size, mtime, json FROM fingerprints WHERE engine=? AND path IN (%s)' % ','.join('?' * len(chunk))
                    for path, size, mtime, text in db.execute(q, [engine, *chunk]):
                        if want.get(path) == (size, mtime):
                            try:
                                value = json.loads(text)
                            except ValueError:
                                continue
                            if isinstance(value, dict):
                                out[path] = value
            except sqlite3.Error:
                pass
        return out

    def put_fingerprints(self, engine: str, rows: list[tuple[str, int, int, dict]]) -> None:
        """Store [(path, size, mtime, fingerprint dict)] (replaces the previous document of that path)."""
        if not rows:
            return
        with self._lock:
            db = self._db()
            if db is None:
                return
            try:
                db.execute('BEGIN')
                db.executemany('INSERT OR REPLACE INTO fingerprints(path, engine, size, mtime, json) VALUES (?,?,?,?,?)',
                               [(p, engine, s, m, json.dumps(v, ensure_ascii=False, separators=(',', ':'))) for p, s, m, v in rows])
                db.execute('COMMIT')
            except sqlite3.Error as e:
                try:
                    db.execute('ROLLBACK')
                except sqlite3.Error:
                    pass
                log.debug('put_fingerprints failed: %s', e)

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                except sqlite3.Error:
                    pass
                self._conn = None


def for_root(root: str) -> MediaCache:
    key = os.path.normcase(root)
    with _caches_lock:
        cache = _caches.get(key)
        if cache is None:
            cache = MediaCache(os.path.join(root, DATA_DIR_NAME, 'hashes.sqlite'))
            _caches[key] = cache
        return cache


def for_workspace(ws) -> MediaCache:
    return for_root(ws.root)


def for_external(data_dir) -> MediaCache:
    """Fingerprints of files outside any workspace (external roots stay read-only): <app data>/fingerprints.sqlite,
    keyed by the normcase absolute path."""
    db_path = os.path.join(str(data_dir), 'fingerprints.sqlite')
    key = 'external:' + os.path.normcase(db_path)
    with _caches_lock:
        cache = _caches.get(key)
        if cache is None:
            cache = MediaCache(db_path)
            _caches[key] = cache
        return cache


def close_all() -> None:
    with _caches_lock:
        caches = list(_caches.values())
        _caches.clear()
    for c in caches:
        c.close()
