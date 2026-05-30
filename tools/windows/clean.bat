@echo off
echo Cleaning PyInstaller output...

pushd "%~dp0..\.."

if exist dist\ (
    rmdir /s /q dist
    echo Deleted: dist\
)

if exist build\ (
    rmdir /s /q build
    echo Deleted: build\
)

if exist R4TEditor.spec (
    del /q R4TEditor.spec
    echo Deleted: R4TEditor.spec
)

popd

echo Done.
pause
