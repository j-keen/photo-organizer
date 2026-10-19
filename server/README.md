# Fluid Identity 로컬 서버

브라우저만으로는 버거운 일을 이 PC 안에서 대신 해 주는 작은 도우미예요. 사진·영상은 어디에도 올라가지 않고,
서버는 `127.0.0.1`(내 PC)에서만 연결을 받아요. 켜지 않아도 앱은 그대로 쓸 수 있어요.

| 서버를 켜면 | 이렇게 좋아져요 |
| --- | --- |
| 미리보기 | HEIC·TIFF 사진, AVI·WMV·MTS 같은 영상도 썸네일과 재생이 돼요. 썸네일은 디스크에 저장돼서 다음부터 바로 떠요. |
| 영상 도구 | 무손실 자르기, 여러 구간 합치기, 무손실 회전·뒤집기, 장면을 사진으로 저장 (ffmpeg 내장) |
| 중복 찾기 | 똑같은 파일 + 크기·화질만 다른 비슷한 사진·영상까지 FAISS로 빠르게 찾아요. |
| 작업 폴더 | Windows 폴더 선택 창, 경로 붙여넣기, 최근 작업 폴더 (브라우저가 바뀌어도 남아요) |
| 탐색기 연동 | 탐색기에서 보기 `Alt+Shift+R`, 기본 앱으로 열기 `Alt+Enter`, 전체 경로 복사 `Alt+Shift+C` |
| 안전 | 이동·복사할 때 원본 날짜 유지, 사용 중인 영상도 바로 휴지통으로 이동, 앱 휴지통을 비우면 Windows 휴지통으로 한 번 더 보관 |

## 켜는 방법

1. Python 3.10 이상을 설치해 주세요 ([python.org](https://www.python.org/downloads/)). 설치 첫 화면에서 **Add python.exe to PATH**를 꼭 체크해 주세요.
2. `server\start.bat`을 **한 번** 더블클릭해요. 처음에는 준비하느라 1~2분 걸려요(인터넷 필요). 다 되면 브라우저에서 앱이 저절로 열려요.
3. 처음 켜지는 순간 바탕화면과 시작 메뉴에 **사진영상정리기** 아이콘이 생겨요.
4. **다음부터는 그 아이콘만 누르면 돼요.** 검은 창 없이 서버가 켜지고, 앱이 마지막에 보던 작업 폴더로 바로 열려요.

- 아이콘을 두 번 눌러도 서버는 하나만 떠요(이미 켜져 있으면 브라우저만 열어요).
- 앱을 새 버전으로 바꿨는데 예전 서버가 켜져 있으면, 아이콘이 예전 서버를 끄고 새 서버를 켜요. 앱에서도 상태 표시줄의
  **서버 업데이트 → 다시 켜기**로 바로 바꿀 수 있어요.
- 끌 때는 앱 아래쪽 **서버 연결됨 → 서버 끄기**를 눌러요. 아이콘이 지워졌다면 명령 팔레트의 **바탕화면 아이콘 만들기**로 다시 만들 수 있어요.
- 창 없이 도는 동안의 기록은 `%APPDATA%\FluidIdentity\server.log`에 남아요. 문제가 생기면 Windows 알림 창으로 알려 줘요.
- `사진영상정리기.html`을 파일로 열어 쓰다가 서버가 켜지면 **서버로 계속하기** 한 번으로 넘어가요. 보던 폴더와 설정을 그대로 가져가요.

구성 요소는 `requirements.txt`가 바뀌었을 때만 다시 설치해요.

## 중복 검사 v2 (서버 엔진)

주인님의 `find_dupes.py` 규칙을 그대로 써요: 크기 → 앞뒤 1MB 해시 → 전체 해시로 **완전히 같은 파일**, 길이가 거의 같은 영상끼리
15·35·50·65·85% 다섯 장면을 9×8 흑백 지문(dHash)으로 비교해서 **같은 영상**을 찾아요. 길이 차이가 0.3초 이하면 "확실", 아니면 "애매".

- 지문은 미리 만들어 두면(`지문 만들기`) 다음 검사는 몇 초면 끝나요. 바뀐 파일만 다시 읽어요. 일시정지·취소 가능.
- 작업 폴더 밖 폴더(예: `D:\VideoDownloader`)도 **직접 고른 폴더만** 검사해요. 그 폴더에는 아무것도 쓰지 않아요
  (지문은 `%APPDATA%\FluidIdentity\fingerprints.sqlite`).
- 그런 폴더의 중복은 지우지 않고 `<그 폴더>\_중복정리\001_이름.mp4`처럼 옮겨 두고 `정리기록.json`에 적어요. 언제든 되돌릴 수 있고(Ctrl+Z),
  되돌릴 자리에 다른 파일이 있으면 `이름 (복원).mp4`로 살려요. 절대 덮어쓰지 않아요.

### 앱에서는 이렇게 보여요

- 서버 주소(**http://127.0.0.1:8765/**)로 열면 상태 표시줄 오른쪽에 **● 서버 연결됨**이 떠요. 누르면 기능 목록과 작업 폴더가 보여요.
- `사진영상정리기.html`을 파일로 직접 열었는데 서버가 켜져 있으면 **서버로 열기**가 나타나요. 누르면 서버 주소로 옮겨 가요.
- 서버가 꺼져 있으면 HEIC·AVI 같은 파일에 작은 **서버** 배지가 붙어요. 배지나 상태 표시줄의 **서버 꺼짐**을 누르면 켜는 방법이 나오고,
  서버가 켜지는 순간 안내 창이 저절로 초록색으로 바뀌어요.
- 서버가 잠깐 꺼졌다 켜져도 앱이 알아서 다시 연결하고, 열려 있던 작업 폴더를 이어서 보여 줘요.

## 직접 실행하기

저장소 최상위 폴더(이 `server` 폴더의 부모)에서 실행해요.

```bat
python -m venv server\.venv
server\.venv\Scripts\python.exe -m pip install -r server\requirements.txt
server\.venv\Scripts\python.exe -m server --open
server\.venv\Scripts\python.exe -m server --open --port 8790
server\.venv\Scripts\python.exe -m server --open --workspace "D:\사진 보관함"
```

| 옵션 | 설명 |
| --- | --- |
| `--open` | 서버가 켜지면 브라우저로 앱을 열어요. |
| `--port N` | 포트 번호 (기본 8765). 기본 포트를 다른 프로그램이 쓰고 있으면 다음 빈 포트를 자동으로 골라요. |
| `--workspace 폴더` | 시작할 때 이 폴더를 작업 폴더로 열어요. |
| `--resume` | 마지막으로 쓴 작업 폴더를 다시 열어요 (바탕화면 아이콘이 써요). |
| `--install-shortcut` | 처음 켜졌을 때 바탕화면·시작 메뉴 아이콘을 만들어요 (`start.bat`이 써요, 한 번만). |
| `--wait-port` | 포트가 빌 때까지 기다렸다 켜요 (앱의 **다시 켜기**가 써요). |
| `--log-level info` | 요청 로그를 자세히 봐요 (기본 warning). |

## 개인정보와 보안

- `127.0.0.1`에만 바인딩하고, `Host` 헤더가 `127.0.0.1:<포트>`/`localhost:<포트>`가 아니면 거절해요 (DNS 리바인딩 방어).
- 세션 쿠키 `fi_session`(`HttpOnly; SameSite=Strict`)은 서버가 직접 띄운 페이지에만 발급해요(`Sec-Fetch-Site`가 `same-origin`/`none`일 때).
  변경 요청에는 `X-FI-Client: 1` 헤더와 같은 출처(Origin)가 필요해요. 다른 사이트의 CORS 사전 요청은 절대 허용하지 않아요.
- 모든 경로는 작업 폴더 기준 상대 경로만 받아요. `..`, 절대 경로, 드라이브 문자, `:`(대체 데이터 스트림), `CON` 같은 예약 이름,
  작업 폴더 밖을 가리키는 바로 가기(심볼릭 링크·junction)는 모두 거절해요.
- 기본 앱으로 열기는 사진·영상 파일만 열어요. 작업 폴더 안에 있는 프로그램은 실행하지 않아요.
- `GET /api/health`만 세션 없이 열려 있어요(앱 이름과 버전만 알려 줘요).

| 저장 위치 | 내용 |
| --- | --- |
| `<작업 폴더>\.fluid-organizer\workspace.json` | 작업 폴더 ID (브라우저 방식과 서버 방식이 같은 정보를 함께 써요) |
| `<작업 폴더>\.fluid-organizer\thumbs\` | 썸네일 캐시 (지워도 다시 만들어져요) |
| `<작업 폴더>\.fluid-organizer\hashes.sqlite` | 중복 찾기 해시와 미디어 정보 캐시 |
| `%APPDATA%\FluidIdentity\recent.json` | 최근 작업 폴더 목록 (macOS `~/Library/Application Support/FluidIdentity`, Linux `~/.config/fluid-identity`) |

## 문제가 생겼을 때

| 상황 | 이렇게 해 보세요 |
| --- | --- |
| Python을 찾을 수 없다고 나와요 | python.org에서 3.10 이상을 설치하고 **Add python.exe to PATH**를 체크한 뒤 `start.bat`을 다시 실행해요. |
| 구성 요소 설치에 실패했어요 | 인터넷 연결과 디스크 공간을 확인하고 다시 실행해요. 계속 실패하면 `server\.venv` 폴더를 지우고 처음부터 설치해요. |
| 포트를 쓸 수 없다고 나와요 | Windows가 예약했거나 다른 프로그램이 쓰는 번호예요. `--port 8790`처럼 다른 번호로 실행해요. |
| 방화벽 경고가 떠요 | 서버는 내 PC 안에서만 쓰여요. 공용 네트워크 허용은 필요 없어요. |
| 폴더 선택 창이 안 보여요 | 작업 표시줄에서 "작업 폴더 선택" 창을 찾아 주세요. 앱의 **경로로 열기**에 폴더 경로를 붙여 넣어도 돼요. |
| 파일을 옮길 수 없어요 | 다른 프로그램(편집기, 재생기)이 그 파일을 쓰고 있는지 확인하고 닫은 뒤 다시 해요. |
| 처음에 썸네일이 느려요 | 처음 한 번만 만들어서 저장해요. 명령 팔레트의 **이 폴더 썸네일 미리 만들기 (서버)**로 미리 만들어 둘 수도 있어요. |

## 개발자 안내

공개 계약은 `docs/server-api.md`예요. 오류는 `{"error": {"code", "message"}}`, 시각은 정수 밀리초, 경로는 `/`로 구분한 작업 폴더 기준 상대 경로예요.
오류 코드: `ENOENT` 404 · `EEXIST` 409 · `EINVAL` 400/415 · `EPERM` 403 · `EBUSY` 423 · `ESERVER` 500 ·
★`ESESSION` 401(세션 다시 받기) · ★`ENOWS` 409(작업 폴더 다시 열기) · ★`ENOTSUP` 501(ffmpeg 등 없음).

서버 확장(★):

| API | 설명 |
| --- | --- |
| 파일·미디어·영상·중복 API의 `?ws=<token>` | 요청마다 작업 폴더를 지정해요 (탭마다 다른 작업 폴더를 열어도 안전). 토큰은 폴더 경로에서 만들어져 서버를 다시 켜도 같아요. |
| `GET /api/session` → `appRoot`, `capabilities` | 앱 폴더 경로와 기능(ffmpeg, faiss, heif, avif, x264, pick, reveal) |
| `POST /api/workspace/pick/cancel`, `POST /api/workspace/forget` | 열린 폴더 선택 창 닫기, 최근 목록에서 지우기 |
| `GET /api/fs/exists` | 항상 200 `{exists, kind}` — 브라우저 콘솔에 404가 쌓이지 않게 해요 |
| `GET /api/fs/file?missingOk=1` | 없는 파일이면 204 + `X-FI-Missing: 1` |
| `POST /api/fs/remove {recycle: true}` | Windows 휴지통으로 보내요 (앱 휴지통 비우기에 사용) |
| `POST /api/fs/open` | 기본 앱으로 열기 (사진·영상만) |
| `GET /api/thumb?soft=1`, `GET /api/media/probe?soft=1` | 실패하면 204 + `X-FI-Error` |
| `GET /api/thumb` 응답 헤더 | `X-FI-Width`, `X-FI-Height`, `X-FI-Duration` (원본 크기·길이), `v=` 파라미터가 있으면 영구 캐시 |
| `GET /api/media/stream?start=초` | 브라우저가 못 여는 영상을 조각난 MP4로 실시간 변환 (H.264면 재인코딩 없이 리먹스) |
| `POST /api/thumbs/pregenerate {dirs, size}` | 썸네일 미리 만들기 작업 |
| `POST /api/server/shutdown` | 앱에서 서버 끄기 |

구조: `app.py`(팩토리·정적 파일) · `security.py`(Host/세션/헤더 검사) · `paths.py`(경로 검증) · `fsutil.py`(Windows 공유 열기·원자적 쓰기·휴지통) ·
`workspaces.py` · `jobs.py` · `ffmpeg.py`(번들 ffmpeg, 진행률, 프로브) · `mediacache.py`(SQLite) · `routes_fs.py` · `routes_workspace.py` ·
`media.py`(썸네일·프로브·스트림) · `video.py` · `dupes.py`(BLAKE2b + pHash + FAISS).

테스트는 저장소 최상위 폴더에서 실행해요. 실제 HTTP 서버를 임시 작업 폴더로 띄워서 검사해요.

```bat
server\.venv\Scripts\python.exe -m unittest discover -s server/tests -t .
node tests/run.js server
```

테스트용 환경 변수: `FI_DATA_DIR`(최근 목록 위치), `FI_DRY_SHELL=1`(탐색기·기본 앱을 실제로 띄우지 않음), `FI_PICK_RESULT=<폴더>`(폴더 선택 창 대신 이 값 사용).
