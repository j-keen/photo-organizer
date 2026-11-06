"""Portable OCR HTTP tests; Windows execution is replaced at the subprocess boundary."""
from __future__ import annotations

import json
import os
import subprocess
import unittest
from unittest.mock import patch

from server import ocr
from server.errors import ApiError
from server.tests.helpers import ServerTestCase, make_image


class OcrTests(ServerTestCase):
    def setUp(self):
        super().setUp()
        make_image(self.path('글자 사진.png'))

    def post_ocr(self, path):
        return self.api.post('/api/ocr', {'path': path}, query={'ws': self.api.ws})

    def test_text_boxes_and_workspace(self):
        expected = {'text': '안녕하세요', 'lines': [
            {'text': '안녕하세요', 'box': {'x': 10, 'y': 20, 'w': 90, 'h': 30}}]}
        with patch.object(ocr, '_powershell', return_value=expected) as call:
            response = self.post_ocr('글자 사진.png')
        self.assertEqual(response.status, 200, response.text)
        self.assertEqual(response.json(), expected)
        self.assertEqual(call.call_args.args[0], {'path': self.path('글자 사진.png')})

    def test_blank(self):
        with patch.object(ocr, '_powershell', return_value={'text': '', 'lines': []}):
            self.assertEqual(self.post_ocr('글자 사진.png').json(), {'text': '', 'lines': []})

    def test_validation_before_execution(self):
        self.write('ocr.txt', 'hello')
        with patch.object(ocr, '_powershell') as call:
            self.assertError(self.post_ocr('../escape.png'), 403, 'EPERM')
            self.assertError(self.post_ocr('missing.png'), 404, 'ENOENT')
            self.assertError(self.post_ocr('ocr.txt'), 400, 'EINVAL')
            self.assertError(self.post_ocr(''), 400, 'EINVAL')
            self.assertError(self.post_ocr(12), 400, 'EINVAL')
            call.assert_not_called()

    def test_errors_release_worker(self):
        for code, status in (('ENOTSUP', 501), ('ESERVER', 500), ('EINVAL', 400)):
            with patch.object(ocr, '_powershell', side_effect=ApiError(code, '추출하지 못했어요')):
                self.assertError(self.post_ocr('글자 사진.png'), status, code)
        with patch.object(ocr, '_powershell', return_value={'text': '', 'lines': []}):
            self.assertEqual(self.post_ocr('글자 사진.png').status, 200)

    def test_busy(self):
        self.assertTrue(ocr._worker.acquire(blocking=False))
        try:
            with patch.object(ocr, '_powershell') as call:
                self.assertError(self.post_ocr('글자 사진.png'), 423, 'EBUSY')
                call.assert_not_called()
        finally:
            ocr._worker.release()

    def test_security(self):
        with patch.object(ocr, '_powershell') as call:
            self.assertError(self.api.post('/api/ocr', {'path': '글자 사진.png'}, cookie=False), 401, 'ESESSION')
            self.assertError(self.api.post('/api/ocr', {'path': '글자 사진.png'}, client_header=False), 403, 'EPERM')
            call.assert_not_called()


class PowerShellTests(unittest.TestCase):
    def run_mock(self, result=None, error=None):
        return patch.object(ocr.subprocess, 'run', return_value=result, side_effect=error)

    def test_stdin_and_hidden_process(self):
        path = 'C:\\사진\\a\'$(whoami).png'
        completed = subprocess.CompletedProcess([], 0, json.dumps({'text': '한글', 'lines': []}).encode('ascii'), b'')
        with patch.object(ocr.os, 'name', 'nt'), patch.object(ocr.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True):
            with self.run_mock(completed) as call:
                self.assertEqual(ocr._powershell({'path': path})['text'], '한글')
        args, kwargs = call.call_args
        self.assertNotIn(path, ' '.join(args[0]))
        self.assertIsInstance(kwargs['input'], bytes)
        self.assertTrue(kwargs['input'].isascii())
        self.assertIn(b'\\u', kwargs['input'])
        self.assertEqual(json.loads(kwargs['input'].decode('utf-8')), {'path': path})
        self.assertNotIn('encoding', kwargs)
        self.assertNotIn('text', kwargs)
        self.assertTrue(kwargs['capture_output'])
        self.assertEqual(kwargs['creationflags'], 0x08000000)
        self.assertEqual(kwargs['timeout'], 60)

    def test_utf8_output_and_legacy_stderr(self):
        expected = {'text': '거래량 급증 구간 123', 'lines': []}
        with patch.object(ocr.os, 'name', 'nt'), patch.object(ocr.subprocess, 'CREATE_NO_WINDOW', 0, create=True):
            for escaped in (False, True):
                output = json.dumps(expected, ensure_ascii=escaped).encode('utf-8')
                completed = subprocess.CompletedProcess([], 0, b'\xef\xbb\xbf' + output, b'\xc0\xff')
                with self.run_mock(completed):
                    self.assertEqual(ocr._powershell({'path': '사진.png'}), expected)
        self.assertEqual(
            ocr._SCRIPT.lstrip().splitlines()[:2],
            [
                '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
                '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
            ],
        )

    def test_invalid_utf8_output(self):
        completed = subprocess.CompletedProcess([], 0, b'{"text":"\xc0","lines":[]}', b'\xc0')
        with patch.object(ocr.os, 'name', 'nt'), patch.object(ocr.subprocess, 'CREATE_NO_WINDOW', 0, create=True):
            with self.run_mock(completed):
                self.assertEqual(ocr._powershell({'path': 'image.png'})['text'], '\ufffd')

    def test_timeout_invalid_output_and_unavailable(self):
        cases = [
            (None, subprocess.TimeoutExpired('powershell', 60), 'ESERVER'),
            (subprocess.CompletedProcess([], 0, b'invalid', b'\xc0'), None, 'ESERVER'),
            (subprocess.CompletedProcess([], 0, b'{"error":"ENOTSUP"}', b''), None, 'ENOTSUP'),
            (subprocess.CompletedProcess([], 0, b'{"error":"EINVAL"}', b''), None, 'EINVAL'),
        ]
        with patch.object(ocr.os, 'name', 'nt'), patch.object(ocr.subprocess, 'CREATE_NO_WINDOW', 0, create=True):
            for result, error, code in cases:
                with self.run_mock(result, error), self.assertRaises(ApiError) as raised:
                    ocr._powershell({'path': 'image.png'})
                self.assertEqual(raised.exception.code, code)

    def test_capability(self):
        with patch.object(ocr, '_powershell', return_value={'available': True}):
            self.assertTrue(ocr.available())
        with patch.object(ocr, '_powershell', side_effect=ApiError('ENOTSUP', '지원하지 않아요')):
            self.assertFalse(ocr.available())


if __name__ == '__main__':
    unittest.main()
