
@echo off
setlocal
cd /d "%~dp0"
title AI Vocal Separation Studio

echo ==========================================
echo    AI Vocal Separation Studio
echo ==========================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo Creating Python environment...
    python -m venv .venv
    if errorlevel 1 goto setup_error
)

call ".venv\Scripts\activate.bat"

echo Installing project dependencies...
python -m pip install --upgrade pip
if errorlevel 1 goto setup_error

python -m pip install -r requirements.txt
if errorlevel 1 goto setup_error

echo.
echo Starting the studio...
echo Open http://127.0.0.1:5000 in your browser.
start "" http://127.0.0.1:5000

python app.py
goto end

:setup_error
echo.
echo Setup failed. Check that Python 3.11 is installed
echo and available from the command line.
pause
exit /b 1

:end
echo.
echo Studio stopped.
pause
