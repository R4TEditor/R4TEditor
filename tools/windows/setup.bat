@echo off
setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set TOOLS_DIR=%SCRIPT_DIR%..
set PROJECT_DIR=%SCRIPT_DIR%..\..
set MAIN_PY=%PROJECT_DIR%\backend\main.py

echo.
echo ==============================
echo     R4TEditor Setup
echo ==============================
echo.

:: --- Step 1: build or run?
echo What do you want to do?
echo   1) Build the project (creates a standalone binary)
echo   2) Run the project
echo.
set /p MODE_CHOICE=Enter 1 or 2: 
echo.

if "%MODE_CHOICE%"=="1" set MODE=build
if "%MODE_CHOICE%"=="2" set MODE=run
if not defined MODE (
    echo [R4TEditor] ERROR: Invalid choice. Please enter 1 or 2.
    pause
    exit /b 1
)

:: --- Step 2: dev mode?
echo Enable dev mode? (appends -dev to version)
set /p DEV_CHOICE=Dev mode? [y/N]: 
echo.

set DEV_MODE=false
if /i "%DEV_CHOICE%"=="y" set DEV_MODE=true

:: --- Apply / revert -dev version tag in main.py
:: Read current version
for /f "tokens=2 delims==" %%A in ('findstr "APP_VERSION" "%MAIN_PY%"') do (
    set RAW=%%A
)
:: Strip spaces and quotes to get bare version string
set CURRENT_VERSION=!RAW: =!
set CURRENT_VERSION=!CURRENT_VERSION:"=!
set CURRENT_VERSION=!CURRENT_VERSION:APP_VERSION ==!

if "!DEV_MODE!"=="true" (
    :: Only append -dev if not already present
    echo !CURRENT_VERSION! | findstr /C:"-dev" >nul || (
        set NEW_VERSION=!CURRENT_VERSION!-dev
        echo [R4TEditor] Setting version to !NEW_VERSION! in backend\main.py ...
        powershell -Command "(Get-Content '%MAIN_PY%') -replace 'APP_VERSION = \"!CURRENT_VERSION!\"', 'APP_VERSION = \"!NEW_VERSION!\"' | Set-Content '%MAIN_PY%'"
        echo [R4TEditor] Version set to !NEW_VERSION!
    )
) else (
    :: Strip -dev if present
    echo !CURRENT_VERSION! | findstr /C:"-dev" >nul && (
        set BASE_VERSION=!CURRENT_VERSION:-dev=!
        echo [R4TEditor] Reverting dev version to !BASE_VERSION! ...
        powershell -Command "(Get-Content '%MAIN_PY%') -replace 'APP_VERSION = \"!CURRENT_VERSION!\"', 'APP_VERSION = \"!BASE_VERSION!\"' | Set-Content '%MAIN_PY%'"
        echo [R4TEditor] Version reverted to !BASE_VERSION!
    )
)

echo.

:: --- Step 3: install deps
call "%SCRIPT_DIR%install_deps.bat"
echo.

:: --- Step 4: branch on mode
if "!MODE!"=="build" (
    echo [R4TEditor] Cleaning previous build artifacts ...
    call "%SCRIPT_DIR%clean.bat"
    echo.
    echo [R4TEditor] Building ...
    call "%SCRIPT_DIR%build.bat"
) else (
    echo [R4TEditor] Launching R4TEditor ...
    :: Windows has no dev/auto-reload bat; launch normally and note dev mode
    if "!DEV_MODE!"=="true" (
        echo [R4TEditor] NOTE: Dev mode version tag applied. Auto-reload not supported on Windows.
        echo [R4TEditor] Use 'py -m uvicorn backend.main:app --reload' manually for hot-reload.
        echo.
    )
    :: Find and activate venv, then run
    set VENV=%TOOLS_DIR%\.venv\Scripts\activate.bat
    if not exist "!VENV!" (
        echo [R4TEditor] ERROR: venv not found at tools\.venv. Run install_deps.bat first.
        pause
        exit /b 1
    )
    call "!VENV!"
    python "%PROJECT_DIR%\backend\main.py"
)

endlocal
