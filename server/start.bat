@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
title Fluid Identity Local Server
cd /d "%~dp0" || goto folder_error

echo.
echo   Preparing Fluid Identity local server...
echo.

set "VENV_PY=%~dp0.venv\Scripts\python.exe"
if not exist "%VENV_PY%" goto create_venv
"%VENV_PY%" -c "import sys; sys.exit(0 if sys.version_info>=(3,12) else 1)" >nul 2>&1 && goto check_requirements
echo   Rebuilding the unavailable or outdated Python environment.
rmdir /s /q ".venv" >nul 2>&1

:create_venv
call :find_python
if not defined FI_PY goto no_python
"%FI_PY%" %FI_PY_ARGS% "%~dp0bootmsg.py" preparing
"%FI_PY%" %FI_PY_ARGS% -m venv ".venv"
if errorlevel 1 goto venv_error

:check_requirements
"%VENV_PY%" "%~dp0bootmsg.py" ready
if not exist "requirements.txt" goto requirements_error
if not exist ".venv\requirements.stamp" goto install_requirements
fc /b ".venv\requirements.stamp" "requirements.txt" >nul 2>&1 || goto install_requirements
"%VENV_PY%" -c "import fastapi, uvicorn, PIL, numpy, faiss, imageio_ffmpeg" >nul 2>&1 || goto install_requirements
goto run_server

:install_requirements
"%VENV_PY%" "%~dp0bootmsg.py" installing
"%VENV_PY%" -m pip install --disable-pip-version-check --upgrade -r "requirements.txt"
if errorlevel 1 goto pip_error
"%VENV_PY%" -c "import fastapi, uvicorn, PIL, numpy, faiss, imageio_ffmpeg" >nul 2>&1 || goto pip_error
copy /b /y "requirements.txt" ".venv\requirements.stamp" >nul

:run_server
cd /d "%~dp0.." || goto folder_error
rem --install-shortcut: create desktop and Start menu shortcuts after successful startup.
rem From then on that icon starts the server without this window and opens the app on the last workspace.
"%VENV_PY%" -m server --open --install-shortcut %*
set "FI_EXIT=%ERRORLEVEL%"
if "%FI_EXIT%"=="0" exit /b 0
echo.
"%VENV_PY%" "%~dp0bootmsg.py" server_error
pause
exit /b %FI_EXIT%

rem ---------------------------------------------------------------------------
rem Find Python 3.12+ : py launcher (3.13/3.12 first) -> python on PATH (not the
rem Microsoft Store alias) -> standard install folders. Sets FI_PY / FI_PY_ARGS.
rem ---------------------------------------------------------------------------
:find_python
set "FI_PY="
set "FI_PY_ARGS="
where py >nul 2>&1 && (
    for %%V in (3.13 3.12 3) do (
        if not defined FI_PY (
            py -%%V -c "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)" >nul 2>&1 && (
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
            "%%P" -c "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)" >nul 2>&1 && set "FI_PY=%%P"
        )
    )
)
if defined FI_PY exit /b 0
for %%V in (313 312 314) do (
    for %%D in ("%LOCALAPPDATA%\Programs\Python\Python%%V" "%ProgramFiles%\Python%%V" "%ProgramFiles(x86)%\Python%%V") do (
        if not defined FI_PY if exist "%%~D\python.exe" (
            "%%~D\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)" >nul 2>&1 && set "FI_PY=%%~D\python.exe"
        )
    )
)
exit /b 0

:no_python
echo   Python 3.12 or newer is required: https://www.python.org/downloads/
echo   Select "Add python.exe to PATH" during installation.
echo   Run this file again after installing Python.
goto failed

:folder_error
if not defined VENV_PY goto folder_error_english
if not exist "%VENV_PY%" goto folder_error_english
"%VENV_PY%" "%~dp0bootmsg.py" folder_error && goto failed
:folder_error_english
echo   Cannot open the server folder. Extract all program files and try again.
goto failed

:venv_error
rem Use the validated base interpreter because venv creation may have failed.
"%FI_PY%" %FI_PY_ARGS% "%~dp0bootmsg.py" venv_error
goto failed

:requirements_error
"%VENV_PY%" "%~dp0bootmsg.py" requirements_error
goto failed

:pip_error
"%VENV_PY%" "%~dp0bootmsg.py" pip_error

:failed
echo.
pause
exit /b 1
