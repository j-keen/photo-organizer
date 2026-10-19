# Fluid Identity 로컬 서버

사진과 영상을 내 PC에서 편하게 정리하기 위한 Python 동반 서버예요. 브라우저에서 앱을 열고, 선택한 작업 폴더의 파일을 직접 다뤄요.

| 기능 | 서버를 켜면 할 수 있어요 |
| --- | --- |
| 작업 폴더 | Windows 폴더 선택 창, 최근 작업 폴더, 여러 작업 폴더 사용 |
| 파일 정리 | 빠른 이동과 복사, 수정 시각 유지, 탐색기에서 표시, 기본 앱으로 열기 |
| 미리 보기 | HEIC·TIFF 사진 썸네일, 브라우저가 바로 재생하지 못하는 영상 변환 재생 |
| 영상 도구 | 자르기, 합치기, 회전, 프레임 저장 |
| 중복 찾기 | 파일 내용 비교, 사진·영상 유사도 검색과 FAISS 가속 |

## 빠른 시작

1. Python 3.10 이상을 설치해 주세요. Windows 설치 화면에서 **Add python.exe to PATH**를 선택해 주세요.
2. `server\start.bat`을 두 번 눌러 주세요.
3. 처음에는 가상 환경과 필요한 구성 요소를 설치해요. 설치가 끝나면 브라우저에서 앱이 열려요.
4. 앱에서 작업 폴더를 선택해 주세요. 서버를 끄려면 실행 창에서 Ctrl+C를 누르거나 창을 닫아 주세요.

설치할 때 인터넷이 필요해요. 구성 요소는 requirements.txt가 바뀌거나 설치 상태 확인에 실패했을 때만 다시 설치해요.

## 직접 실행하기

저장소 최상위 폴더에서 실행해 주세요. 직접 설치할 때도 가상 환경을 권장해요.

```bat
python -m venv server\.venv
server\.venv\Scripts\python.exe -m pip install -r server\requirements.txt
server\.venv\Scripts\activate
python -m server --open
python -m server --open --port 8790
python -m server --open --workspace "D:\사진 보관함"
```

기본 주소는 **http://127.0.0.1:8765/**예요. 서버가 제공하는 페이지에서는 앱이 같은 주소의 API에 연결해요. HTML 파일을 `file://`로 직접 열었을 때는 공개 health API로 기본 포트의 서버를 감지하고 **서버로 열기** 안내를 보여 줘요. 다른 포트로 실행했다면 실행 창에 표시된 주소를 직접 열어 주세요.

## 개인정보와 보안

서버는 `127.0.0.1`에만 연결을 받아요. Host 헤더가 해당 포트의 `127.0.0.1` 또는 `localhost`인지 확인해요. 세션은 `HttpOnly`, `SameSite=Strict`, `Path=/` 쿠키로 보호하고, 변경 요청에는 `X-FI-Client: 1` 헤더와 Origin 검사를 적용해요. 다른 사이트의 API 사전 요청은 허용하지 않아요. health API만 서버 감지를 위해 공개돼요.

파일 경로는 작업 폴더 기준 상대 경로로 검사해요. 상위 폴더 이동, 절대 경로, 작업 폴더 밖을 가리키는 심볼릭 링크와 junction은 거절해요. 사진·영상 처리와 중복 검색은 PC 안에서 수행하며 앱이 파일을 외부로 업로드하지 않아요. 기본 앱으로 열기는 PC에 설정한 앱을 실행해요.

| 저장 위치 | 내용 |
| --- | --- |
| `<작업 폴더>\.fluid-organizer\workspace.json` | 작업 폴더 식별 정보 |
| `<작업 폴더>\.fluid-organizer\thumbs` | 썸네일 캐시 |
| `<작업 폴더>\.fluid-organizer\hashes.sqlite` | 해시와 미디어 정보 캐시 |
| `%APPDATA%\FluidIdentity\recent.json` | Windows의 최근 작업 폴더 목록 |

macOS의 최근 목록은 `~/Library/Application Support/FluidIdentity`, Linux는 `$XDG_CONFIG_HOME/fluid-identity` 또는 `~/.config/fluid-identity`에 저장해요. 최근 목록에서 지워도 원본 폴더는 삭제하지 않아요. 파일 삭제 API는 영구 삭제이므로 개발할 때 주의해 주세요.

## 문제가 생겼을 때

| 상황 | 확인해 주세요 |
| --- | --- |
| Python을 찾지 못해요 | python.org에서 3.10 이상을 설치하고 Add python.exe to PATH를 선택한 뒤 실행 창을 다시 열어 주세요. |
| 포트를 사용할 수 없어요 | 기본 포트가 사용 중이면 다음 빈 포트를 자동으로 찾아요. 같은 서버가 이미 켜져 있으면 그 서버를 사용해요. `--port 8790`처럼 직접 지정한 포트는 자동 변경하지 않아요. |
| 방화벽 안내가 떠요 | 서버는 내 PC에서만 사용해요. 외부 네트워크 공개나 공유기 포트 전달 설정은 필요하지 않아요. |
| HEIC가 보이지 않아요 | start.bat을 다시 실행해 설치 상태를 확인해 주세요. 직접 설치했다면 가상 환경에 pillow-heif가 설치돼 있는지 확인해 주세요. |
| 처음 실행이 느려요 | 최초 구성 요소 설치, 썸네일 생성, 해시 계산에는 시간이 걸려요. 이후에는 캐시를 사용해요. |
| 파일을 옮길 수 없어요 | 다른 편집기나 재생기가 파일을 사용 중인지 확인하고 닫은 뒤 다시 시도해 주세요. |

## 개발자 안내

공개 계약은 `docs/server-api.md`, 서버 확장은 SERVER-SPEC.md를 따라요. 오류는 `{error: {code, message}}`, 시각은 정수 밀리초, 경로는 `/` 구분 상대 경로예요. 파일·미디어·영상·중복 API는 ★`?ws=<token>`으로 작업 폴더를 지정할 수 있어요.

| API | 역할 및 확장 |
| --- | --- |
| `GET /api/health`, `GET /api/session` | 서버 감지, 세션 쿠키와 기능 정보 |
| `POST /api/workspace/pick`, `/open`, `GET /recent` | 폴더 선택, 열기, 최근 목록; 선택만으로 열리지는 않아요. |
| ★`POST /api/workspace/pick/cancel`, `/forget` | 선택 창 취소, 최근 목록에서 제거 |
| `GET /api/fs/list`, `/stat`, ★`/exists` | 목록, 정보, 정상적인 빈 이름 확인 |
| `GET|HEAD /api/fs/file` | ETag·Range·HEAD; ★`missingOk=1`이면 없는 파일을 204와 X-FI-Missing으로 응답 |
| `PUT /api/fs/file` | 스트리밍 원자적 저장; 크기와 수정 시각 반환 |
| `POST /api/fs/mkdir`, `/move`, `/copy`, `/remove` | 폴더 생성, 이동, 복사, 영구 삭제; 이동·복사는 결과 path 반환 |
| `POST /api/fs/reveal`, ★`/open` | 탐색기 표시, 기본 앱 실행 |
| `GET /api/thumb`, `/api/media/probe`, `/api/media/stream` | 썸네일, 정보, 변환 재생; ★썸네일 soft=1 실패는 204 |
| ★`POST /api/thumbs/pregenerate` | 썸네일 미리 생성 작업 |
| `POST /api/video/trim`, `/concat`, `/transform`, `/frame` | 영상 도구; ★transform의 inPlace 지원 |
| `POST /api/dupes/scan` | 정확·유사 중복 검색 작업 |
| `GET /api/jobs`, `/api/jobs/<id>`, `POST /api/jobs/<id>/cancel` | 작업 진행 상태와 취소 |

저장소 최상위 폴더에서 테스트해 주세요.

```bat
server\.venv\Scripts\python.exe -m unittest discover -s server/tests -t .
node tests/run.js server
```

테스트는 임시 작업 폴더와 실제 로컬 HTTP 서버를 사용해요. 테스트 설정의 `dry_shell`과 `pick_result`를 사용하면 탐색기나 폴더 선택 창을 띄우지 않고 검증할 수 있어요.
