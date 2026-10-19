@echo off
chcp 65001 >nul
setlocal
 title Fluid Identity 로컬 서버
cd /d "%~dp0"
if errorlevel 1 goto folder_error
set "FI_PY="
py -3.12 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 set "FI_PY=py -3.12"
if defined FI_PY goto python_ready
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 set "FI_PY=py -3"
if defined FI_PY goto python_ready
python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 set "FI_PY=python"
if defined FI_PY goto python_ready
echo Python 3.10 이상이 필요해요.
echo https://www.python.org/downloads/ 에서 Python을 설치해 주세요.
echo 설치 첫 화면에서 "Add python.exe to PATH"를 꼭 선택해 주세요.
echo 설치가 끝나면 이 파일을 다시 열어 주세요.
pause
exit /b 1

:python_ready
if exist ".venv\Scripts\python.exe" goto check_requirements
echo 처음 실행이라 준비하고 있어요. 1~2분 걸려요…
%FI_PY% -m venv ".venv"
if errorlevel 1 goto venv_error

:check_requirements
if not exist "requirements.txt" goto requirements_error
if not exist ".venv\requirements.stamp" goto install_requirements
fc /b ".venv\requirements.stamp" "requirements.txt" >nul 2>&1
if errorlevel 1 goto install_requirements
".venv\Scripts\python.exe" -c "import fastapi, uvicorn, PIL, numpy, faiss, imageio_ffmpeg" >nul 2>&1
if errorlevel 1 goto install_requirements
goto run_server

:install_requirements
echo 필요한 구성 요소를 준비하고 있어요. 인터넷 연결을 확인해 주세요.
".venv\Scripts\python.exe" -m pip install --upgrade -r "requirements.txt"
if errorlevel 1 goto pip_error
".venv\Scripts\python.exe" -c "import fastapi, uvicorn, PIL, numpy, faiss, imageio_ffmpeg" >nul 2>&1
if errorlevel 1 goto pip_error
copy /b /y "requirements.txt" ".venv\requirements.stamp" >nul
if errorlevel 1 goto stamp_error

:run_server
cd ..
"server\.venv\Scripts\python.exe" -m server --open %*
set "FI_EXIT=%ERRORLEVEL%"
if "%FI_EXIT%"=="0" exit /b 0
echo 서버를 실행하다 문제가 생겼어요. 위의 안내를 확인해 주세요.
pause
exit /b %FI_EXIT%

:folder_error
echo 서버 폴더를 열 수 없어요. 압축을 모두 푼 뒤 다시 실행해 주세요.
goto failed
:venv_error
echo Python 실행 환경을 만들 수 없어요. 폴더의 쓰기 권한과 Python 설치를 확인해 주세요.
goto failed
:requirements_error
echo requirements.txt가 없어요. 프로그램 파일을 다시 받아 주세요.
goto failed
:pip_error
echo 구성 요소 설치에 실패했어요. 인터넷 연결과 디스크 공간을 확인한 뒤 다시 실행해 주세요.
goto failed
:stamp_error
echo 설치 기록을 저장할 수 없어요. 서버 폴더의 쓰기 권한을 확인해 주세요.
:failed
pause
exit /b 1
