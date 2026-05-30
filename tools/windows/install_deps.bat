@echo off
echo [R4TEditor] Installing dependencies...

pushd "%~dp0..\.."

where py >nul 2>&1 || (
    echo [R4TEditor] ERROR: Python Launcher ^(py.exe^) not found. Install Python 3.12 from https://python.org
    pause
    exit /b 1
)

py -3.12 --version >nul 2>&1 || (
    echo [R4TEditor] ERROR: Python 3.12 is required but was not found. Install from https://python.org
    pause
    exit /b 1
)

set VENV_DIR=%~dp0..\.venv

if not exist "%VENV_DIR%" (
    echo [R4TEditor] Creating virtual environment at tools\.venv ...
    py -3.12 -m venv "%VENV_DIR%" || (
        echo [R4TEditor] ERROR: Failed to create virtual environment.
        pause
        exit /b 1
    )
    echo [R4TEditor] Virtual environment created.
) else (
    echo [R4TEditor] Virtual environment already exists.
)

call "%VENV_DIR%\Scripts\activate.bat"

echo [R4TEditor] Upgrading pip ...
python -m pip install --quiet --upgrade pip

echo [R4TEditor] Installing dependencies from tools\requirements.txt ...
pip install --quiet -r "%~dp0..\requirements.txt"

echo [R4TEditor] Installing PyInstaller ...
pip install --quiet pyinstaller || echo [R4TEditor] WARNING: PyInstaller install failed, build will not work.

echo [R4TEditor] All dependencies ready.
popd
pause
