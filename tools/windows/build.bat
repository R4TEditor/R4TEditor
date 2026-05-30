@echo off
setlocal

pushd "%~dp0..\.."

call "%~dp0..\..\tools\.venv\Scripts\activate.bat" 2>nul || (
    call "%~dp0..\..\.venv\Scripts\activate.bat" 2>nul || (
        call "%~dp0..\.venv\Scripts\activate.bat" 2>nul || (
            echo [R4TEditor] ERROR: Virtual environment not found. Run install_deps.bat first.
            pause
            exit /b 1
        )
    )
)

python -m PyInstaller ^
    --onefile ^
    --windowed ^
    --icon "frontend\static\favicon.ico" ^
    --add-data "frontend;frontend" ^
    --add-data "themes;themes" ^
    --name "R4TEditor" ^
    --hidden-import uvicorn.logging ^
    --hidden-import uvicorn.loops ^
    --hidden-import uvicorn.loops.auto ^
    --hidden-import uvicorn.protocols ^
    --hidden-import uvicorn.protocols.http.auto ^
    --hidden-import uvicorn.protocols.websockets.auto ^
    --hidden-import uvicorn.lifespan.on ^
    --hidden-import paramiko ^
    --hidden-import pywebview ^
    --hidden-import pywebview.platforms.winforms ^
    --hidden-import pypresence ^
    --hidden-import _cffi_backend ^
    --collect-all cffi ^
    --collect-all clr_loader ^
    backend\main.py

echo [R4TEditor] Build complete. Output: dist\R4TEditor.exe
popd
pause
endlocal
