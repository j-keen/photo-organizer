"""Windows OCR: available() probes the engine; POST /api/ocr returns text and pixel line boxes without writes."""
from __future__ import annotations

import base64
import json
import os
import stat
import subprocess
import threading

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, StrictStr

from . import config, deps
from .errors import ApiError, from_os_error
from .workspaces import Workspace

router = APIRouter()
_worker = threading.BoundedSemaphore(1)

# Fixed source keeps file names (including quotes and Korean) out of executable code.
_SCRIPT = r'''
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$engine = $null
try {
    $language = New-Object Windows.Globalization.Language('ko-KR')
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
} catch {}
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) {
    [Console]::Write('{"error":"ENOTSUP"}')
    exit 0
}
$inputData = [Console]::ReadLine() | ConvertFrom-Json
if ($inputData.probe) {
    [Console]::Write('{"available":true}')
    exit 0
}
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and
    $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
}
$stream = $null
$bitmap = $null
try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($inputData.path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($decoder.PixelWidth -gt $max -or $decoder.PixelHeight -gt $max) {
        [Console]::Write('{"error":"EINVAL"}')
        exit 0
    }
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($result.Lines | ForEach-Object {
        $line = $_
        $left = [double]::PositiveInfinity
        $top = [double]::PositiveInfinity
        $right = 0.0
        $bottom = 0.0
        foreach ($word in $line.Words) {
            $b = $word.BoundingRect
            $left = [Math]::Min($left, $b.X)
            $top = [Math]::Min($top, $b.Y)
            $right = [Math]::Max($right, $b.X + $b.Width)
            $bottom = [Math]::Max($bottom, $b.Y + $b.Height)
        }
        if ($line.Words.Count -gt 0) {
            @{ text = $line.Text; box = @{ x = $left; y = $top; w = $right - $left; h = $bottom - $top } }
        }
    })
    [Console]::Write((@{ text = $result.Text; lines = $lines } | ConvertTo-Json -Depth 6 -Compress))
} catch {
    [Console]::Write('{"error":"EINVAL"}')
} finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
}
'''


def _powershell(payload: dict, timeout: int = 60) -> dict:
    if os.name != 'nt':
        raise ApiError('ENOTSUP', 'Windows 로컬 서버에서 글자를 추출할 수 있어요')
    executable = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'),
                              'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    encoded = base64.b64encode(_SCRIPT.encode('utf-16-le')).decode('ascii')
    try:
        result = subprocess.run(
            [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            input=(json.dumps(payload, ensure_ascii=True) + '\n').encode('utf-8'),
            capture_output=True, timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except FileNotFoundError as exc:
        raise ApiError('ENOTSUP', 'Windows PowerShell을 찾을 수 없어요') from exc
    except subprocess.TimeoutExpired as exc:
        raise ApiError('ESERVER', '글자 추출 시간이 오래 걸려요. 더 작은 사진으로 다시 해 주세요') from exc
    except OSError as exc:
        raise ApiError('ESERVER', '글자 추출 도우미를 실행하지 못했어요') from exc
    try:
        # PowerShell diagnostics can use the system code page; keep pipe reads binary.
        data = json.loads(result.stdout.decode('utf-8', errors='replace').lstrip('\ufeff'))
        if result.returncode or not isinstance(data, dict):
            raise ValueError('invalid OCR response')
    except (ValueError, TypeError) as exc:
        raise ApiError('ESERVER', '글자를 추출하지 못했어요. 잠시 후 다시 해 주세요') from exc
    if data.get('error') == 'ENOTSUP':
        raise ApiError('ENOTSUP', 'Windows 설정에서 OCR 언어 팩을 설치해 주세요')
    if data.get('error'):
        raise ApiError('EINVAL', '사진을 읽을 수 없어요. 사진 크기와 형식을 확인해 주세요')
    return data


def available() -> bool:
    """True only when Windows can create a Korean or user-profile OCR engine."""
    try:
        return _powershell({'probe': True}, timeout=15).get('available') is True
    except ApiError:
        return False


class OcrBody(BaseModel):
    model_config = ConfigDict(extra='ignore')
    path: StrictStr


@router.post('/api/ocr')
def recognize(body: OcrBody, ws: Workspace = Depends(deps.workspace)):
    absolute = ws.resolve(body.path)
    try:
        info = os.stat(absolute)
    except OSError as exc:
        raise from_os_error(exc, body.path, noun='파일') from exc
    if not stat.S_ISREG(info.st_mode) or config.media_type(body.path) != 'image' or config.ext_of(body.path) == 'svg':
        raise ApiError('EINVAL', '글자를 추출할 사진 파일을 골라 주세요')
    if not _worker.acquire(blocking=False):
        raise ApiError('EBUSY', '다른 사진에서 글자를 추출하고 있어요. 잠시 후 다시 해 주세요')
    try:
        return _powershell({'path': absolute})
    finally:
        _worker.release()
