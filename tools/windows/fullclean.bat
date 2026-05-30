@echo off
echo Cleaning...

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
pushd "%~dp0.."
if exist .venv\ (
    rmdir /s /q .venv
    echo Deleted: Enviroment
)
popd

echo Done.
pause
