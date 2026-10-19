"""/api/jobs — list, inspect and cancel background jobs."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from . import deps
from .jobs import JobManager

router = APIRouter()


@router.get('/api/jobs')
def list_jobs(jobs: JobManager = Depends(deps.jobs)):
    return [j.to_dict() for j in jobs.list()]


@router.get('/api/jobs/{job_id}')
def get_job(job_id: str, jobs: JobManager = Depends(deps.jobs)):
    return jobs.get(job_id).to_dict()


@router.post('/api/jobs/{job_id}/cancel')
def cancel_job(job_id: str, jobs: JobManager = Depends(deps.jobs)):
    job = jobs.get(job_id)
    job.cancel()
    return {'ok': True, 'state': job.state}
