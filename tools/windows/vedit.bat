@echo off
setlocal enabledelayedexpansion

set MAIN_PY=%~dp0..\..\backend\main.py

:: --- Read current version
for /f "tokens=*" %%A in ('findstr "APP_VERSION" "%MAIN_PY%"') do set RAW=%%A
set CURRENT_VERSION=!RAW:APP_VERSION = "=!
set CURRENT_VERSION=!CURRENT_VERSION:"=!
set CURRENT_VERSION=!CURRENT_VERSION: =!

echo.
echo Current version: !CURRENT_VERSION!
set /p NEW_VERSION=New version: 
echo.

if "!NEW_VERSION!"=="" (
    echo [R4TEditor] No version entered. Aborting.
    pause
    exit /b 1
)

powershell -Command "(Get-Content '%MAIN_PY%') -replace 'APP_VERSION = \"!CURRENT_VERSION!\"', 'APP_VERSION = \"!NEW_VERSION!\"' | Set-Content '%MAIN_PY%'"

echo [R4TEditor] Version updated: !CURRENT_VERSION! ^→ !NEW_VERSION!
pause
endlocal
