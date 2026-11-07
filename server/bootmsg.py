"""Startup messages: python server/bootmsg.py KEY or python -m server.bootmsg KEY.

main(argv=None) prints a known message as UTF-8 and returns an exit status.
MESSAGES maps the ASCII keys used by start.bat to Korean console messages.
"""
from __future__ import annotations

import sys


MESSAGES = {
    'preparing': '처음 실행이라 준비하고 있어요. 1~2분 걸려요...',
    'ready': 'Fluid Identity 로컬 서버를 준비하고 있어요...',
    'installing': '필요한 구성 요소를 설치하고 있어요. 인터넷 연결이 필요해요...',
    'server_error': '서버를 실행하다 문제가 생겼어요. 위에 나온 안내를 확인해 주세요.',
    'folder_error': 'server 폴더를 열 수 없어요. 압축을 모두 푼 뒤 다시 실행해 주세요.',
    'venv_error': '실행 환경을 만들지 못했어요. 폴더에 쓸 수 있는지, Python이 제대로 설치됐는지 확인해 주세요.',
    'requirements_error': 'requirements.txt가 없어요. 프로그램 파일을 다시 받아 주세요.',
    'pip_error': (
        '구성 요소를 설치하지 못했어요. 인터넷 연결과 디스크 공간을 확인한 뒤 다시 실행해 주세요.\n'
        '  계속 안 되면 server\\.venv 폴더를 지우고 다시 실행해 주세요.'
    ),
}


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0] not in MESSAGES:
        print('Usage: bootmsg.py KEY (unknown or missing message key)', file=sys.stderr)
        return 2
    # cmd uses UTF-8 for Python output; keep redirected output consistent too.
    sys.stdout.reconfigure(encoding='utf-8')
    print(f'  {MESSAGES[args[0]]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
