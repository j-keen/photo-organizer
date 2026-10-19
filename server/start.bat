@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Fluid Identity 로컬 서버
cd /d "%~dp0" || goto folder_error

echo.
echo   Fluid Identity 로컬 서버를 준비하고 있어요...
echo.

set "VENV_PY=%~dp0.venv\Scripts\python.exe"
if not exist "%VENV_PY%" goto create_venv
"%VENV_PY%" -c "import sys" >nul 2>&1 && goto check_requirements
echo   예전에 만든 실행 환경이 망가져서 새로 만들어요.
rmdir /s /q ".venv" >nul 2>&1

:create_venv
call :find_python
if not defined FI_PY goto no_python
echo   처음 실행이라 준비하고 있어요. 1~2분 걸려요...
"%FI_PY%" %FI_PY_ARGS% -m venv ".venv"
if errorlevel 1 goto venv_error

:check_requirements
if not exist "requirements.txt" goto requirements_error
if not exist ".venv\requirements.stamp" goto install_requirements
fc /b ".venv\requirements.stamp" "requirements.txt" >nul 2>&1 || goto install_requirements
"%VENV_PY%" -c "import fastapi, uvicorn, PIL, numpy, faiss, imageio_ffmpeg" >nul 2>&1 || goto install_requirements
goto run_server

:install_requirements
echo   필요한 구성 요소를 설치하고 있어요. 인터넷 연결이 필요해요...
"%VENV_PY%" -m pip install --disable-pip-version-check --upgrade -r "requirements.txt"
if errorlevel 1 goto pip_error
"%VENV_PY%" -c "import fastapi, uvicorn, PIL, numpy, faiss, imageio_ffmpeg" >nul 2>&1 || goto pip_error
copy /b /y "requirements.txt" ".venv\requirements.stamp" >nul

:run_server
cd ..
"%VENV_PY%" -m server --open %*
set "FI_EXIT=%ERRORLEVEL%"
if "%FI_EXIT%"=="0" exit /b 0
echo.
echo   서버를 실행하다 문제가 생겼어요. 위에 나온 안내를 확인해 주세요.
pause
exit /b %FI_EXIT%

rem ---------------------------------------------------------------------------
rem Find Python 3.10+ : py launcher (3.12 first) -> python on PATH (not the
rem Microsoft Store alias) -> standard install folders. Sets FI_PY / FI_PY_ARGS.
rem ---------------------------------------------------------------------------
:find_python
set "FI_PY="
set "FI_PY_ARGS="
where py >nul 2>&1 && (
    for %%V in (3.12 3.13 3.11 3.10 3) do (
        if not defined FI_PY (
            py -%%V -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1 && (
                set "FI_PY=py"
                set "FI_PY_ARGS=-%%V"
            )
        )
    )
)
if defined FI_PY exit /b 0
for /f "delims=" %%P in ('where python 2^>nul') do (
    if not defined FI_PY (
        echo %%P| find /i "WindowsApps" >nul || (
            "%%P" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1 && set "FI_PY=%%P"
        )
    )
)
if defined FI_PY exit /b 0
for %%V in (312 313 311 310 314) do (
    for %%D in ("%LOCALAPPDATA%\Programs\Python\Python%%V" "%ProgramFiles%\Python%%V" "%ProgramFiles(x86)%\Python%%V") do (
        if not defined FI_PY if exist "%%~D\python.exe" set "FI_PY=%%~D\python.exe"
    )
)
exit /b 0

:no_python
echo   Python 3.10 이상이 필요해요.
echo   https://www.python.org/downloads/ 에서 설치해 주세요.
echo   설치 첫 화면에서 "Add python.exe to PATH"를 꼭 체크해 주세요.
echo   설치가 끝나면 이 파일을 다시 실행해 주세요.
goto failed

:folder_error
echo   server 폴더를 열 수 없어요. 압축을 모두 푼 뒤 다시 실행해 주세요.
goto failed

:venv_error
echo   실행 환경을 만들지 못했어요. 폴더에 쓸 수 있는지, Python이 제대로 설치됐는지 확인해 주세요.
goto failed

:requirements_error
echo   requirements.txt가 없어요. 프로그램 파일을 다시 받아 주세요.
goto failed

:pip_error
echo   구성 요소를 설치하지 못했어요. 인터넷 연결과 디스크 공간을 확인한 뒤 다시 실행해 주세요.
echo   계속 안 되면 server\.venv 폴더를 지우고 다시 실행해 주세요.

:failed
echo.
pause
exit /b 1
