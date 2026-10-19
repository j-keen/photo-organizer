"""Background jobs (video tools, duplicate scans, thumbnail pre-generation) with progress and cancel.

    job = jobs.submit('video.trim', work, ws=ws, message='자르는 중…')
    def work(job):
        job.set_progress(0.3, '인코딩 중…')
        job.check()                 # raises JobCancelled once cancel() was requested
        job.add_proc(popen)         # running processes are killed on cancel
        return {'path': 'a/b_cut01.mp4'}      # -> job.result
"""
from __future__ import annotations

import logging
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from .errors import ApiError

log = logging.getLogger('fi.jobs')


class JobCancelled(Exception):
    pass


class Job:
    def __init__(self, kind: str, *, ws=None, message: str = '') -> None:
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.ws = ws
        self.state = 'running'  # running | done | error | cancelled
        self.progress = 0.0
        self.message = message or '대기 중…'
        self.result: Any = None
        self.error: dict | None = None
        self.created = time.time()
        self.started: float | None = None
        self.finished: float | None = None
        self._cancel = threading.Event()
        self._running = threading.Event()  # cleared while paused
        self._running.set()
        self._message_before_pause: str | None = None
        self._procs: set[subprocess.Popen] = set()
        self._lock = threading.Lock()
        self.cleanup: list[Callable[[], None]] = []  # run after the job ends (e.g. delete temp files)
        self._future = None

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    @property
    def paused(self) -> bool:
        return self.state == 'running' and not self._running.is_set()

    def set_progress(self, progress: float, message: str | None = None) -> None:
        self.progress = max(0.0, min(1.0, float(progress)))
        if message is not None:
            if self._running.is_set():
                self.message = message
            else:
                self._message_before_pause = message  # shown again on resume

    def check(self) -> None:
        if self._cancel.is_set():
            raise JobCancelled()
        if not self._running.is_set():
            # Paused: every thread of the job blocks at its next check point until resumed or cancelled
            while not self._running.wait(0.2):
                if self._cancel.is_set():
                    raise JobCancelled()
            if self._cancel.is_set():
                raise JobCancelled()

    def pause(self) -> bool:
        """Pause at the next check point (running ffmpeg calls finish first). False when the job already ended."""
        if self.state != 'running' or self._cancel.is_set():
            return False
        with self._lock:
            if self._running.is_set():
                self._message_before_pause = self.message
                self._running.clear()
                self.message = '일시정지했어요'
        return True

    def resume(self) -> bool:
        with self._lock:
            if self._running.is_set():
                return False
            if self.message == '일시정지했어요':
                self.message = self._message_before_pause or '처리하는 중…'
            self._running.set()
        return True

    def add_proc(self, proc: subprocess.Popen) -> None:
        with self._lock:
            self._procs.add(proc)
        if self._cancel.is_set():
            _kill(proc)

    def remove_proc(self, proc: subprocess.Popen) -> None:
        with self._lock:
            self._procs.discard(proc)

    def cancel(self) -> bool:
        if self.state != 'running':
            return False
        self._cancel.set()
        self._running.set()  # wake a paused job so it can stop
        self.message = '취소하는 중…'
        with self._lock:
            procs = list(self._procs)
        for p in procs:
            _kill(p)
        return True

    def to_dict(self) -> dict:
        return {
            'id': self.id,
            'kind': self.kind,
            'state': self.state,
            'paused': self.paused,
            'progress': round(self.progress, 4),
            'message': self.message,
            'result': self.result,
            'error': self.error,
            'createdAt': int(self.created * 1000),
            'finishedAt': int(self.finished * 1000) if self.finished else None,
        }


def _kill(proc: subprocess.Popen) -> None:
    try:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
    except OSError:
        pass


class JobManager:
    def __init__(self, workers: int = 3, keep: int = 200) -> None:
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix='fi-job')
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._keep = keep

    def submit(self, kind: str, fn: Callable[[Job], Any], *, ws=None, message: str = '', cleanup: list[Callable[[], None]] | None = None) -> Job:
        """Queue fn(job). `cleanup` callbacks run when the job ends — also when it is cancelled before it starts."""
        job = Job(kind, ws=ws, message=message)
        job.cleanup.extend(cleanup or ())
        with self._lock:
            self._jobs[job.id] = job
            self._prune()
            job._future = self._executor.submit(self._run, job, fn)
        return job

    def _run(self, job: Job, fn: Callable[[Job], Any]) -> None:
        job.started = time.time()
        try:
            job.check()
            if job.message == '대기 중…':
                job.message = '처리하는 중…'
            result = fn(job)
            job.check()
            job.result = result
            job.progress = 1.0
            job.state = 'done'
            if job.message in ('처리하는 중…', '대기 중…'):
                job.message = '완료했어요'
        except JobCancelled:
            job.state = 'cancelled'
            job.message = '취소했어요'
        except ApiError as e:
            if job.cancelled:
                job.state = 'cancelled'
                job.message = '취소했어요'
            else:
                job.state = 'error'
                job.error = e.to_dict()['error']
                job.message = e.message
        except Exception as e:  # pragma: no cover - logged for diagnosis
            if job.cancelled:
                job.state = 'cancelled'
                job.message = '취소했어요'
            else:
                log.exception('job %s (%s) failed', job.id, job.kind)
                job.state = 'error'
                job.error = {'code': 'ESERVER', 'message': f'작업이 실패했어요 ({type(e).__name__}: {e})'}
                job.message = job.error['message']
        finally:
            self._finalize(job)

    @staticmethod
    def _finalize(job: Job) -> None:
        job.finished = time.time()
        for fn_cleanup in job.cleanup:
            try:
                fn_cleanup()
            except Exception:
                log.debug('job cleanup failed', exc_info=True)
        job.cleanup.clear()
        with job._lock:
            procs = list(job._procs)
        for p in procs:
            _kill(p)

    def _prune(self) -> None:
        if len(self._jobs) <= self._keep:
            return
        finished = sorted((j for j in self._jobs.values() if j.state != 'running'), key=lambda j: j.created)
        for j in finished[: len(self._jobs) - self._keep]:
            self._jobs.pop(j.id, None)

    def get(self, job_id: str) -> Job:
        with self._lock:
            job = self._jobs.get(job_id)
        if not job:
            raise ApiError('ENOENT', '작업을 찾을 수 없어요')
        return job

    def list(self) -> list[Job]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda j: j.created, reverse=True)

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        ok = job.cancel()
        future = job._future
        if future is not None and future.cancel():
            # Still queued: it will never run, so finish it now (state + cleanup)
            job.state = 'cancelled'
            job.message = '취소했어요'
            self._finalize(job)
        return ok

    def shutdown(self) -> None:
        for j in self.list():
            j.cancel()
            future = getattr(j, '_future', None)
            if future is not None and future.cancel():
                # Never started: finish it here so its state and cleanup are not left dangling
                j.state = 'cancelled'
                j.message = '취소했어요'
                self._finalize(j)
        self._executor.shutdown(wait=False, cancel_futures=True)
