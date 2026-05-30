R4TEditor - Tools
=================

This directory contains scripts to install, run, and build R4TEditor.
If you're not sure where to start, run setup, it will ask you what you
want to do and handle everything else for you.

    Linux:    bash tools/linux/setup.sh
    Windows:  tools\windows\setup.bat


Quick Start
-----------
Linux / macOS:
    cd tools/linux
    bash setup.sh

Windows:
    Double-click tools\windows\setup.bat
    (or run it from a Command Prompt)


Scripts
-------
setup
    The main entry point. Asks two questions — build or run, and whether
    to enable dev mode — then calls the other scripts in the right order.
    This is the only script most people will ever need.

install_deps
    Creates a Python virtual environment at tools/.venv and installs
    everything from requirements.txt into it. Safe to run more than once;
    it skips anything already in place. Called automatically by setup,
    but you can run it on its own if you just want to prepare the
    environment without launching anything.

launch
    Starts R4TEditor normally. The app will open in a window and run
    until you close it.

dev  (Linux only)
    Starts the backend via uvicorn with auto-reload enabled. The server
    will restart automatically whenever you save a file under backend/.
    Useful when you're actively making changes and don't want to manually
    restart after every edit. Defaults to port 8000; set the R4T_PORT
    environment variable to use a different one (e.g. R4T_PORT=9000).
    Windows users can get the same effect by running uvicorn manually:
        py -m uvicorn backend.main:app --reload

build
    Packages the project into a single standalone binary using
    PyInstaller. The output lands in dist/R4TEditor (Linux) or
    dist\R4TEditor.exe (Windows). PyInstaller is installed into the
    venv automatically if it isn't there already.

clean
    Deletes the build/, dist/, and R4TEditor.spec files left behind by
    PyInstaller. Run this before a fresh build if you want to start from
    a clean slate. Called automatically by setup when building.

vedit  (Vedit.bat on Windows)
    Changes the version number in backend/main.py. Shows you the current
    version and asks for the new one — that's it.


Dev Mode
--------
When dev mode is on, setup patches the APP_VERSION string in
backend/main.py by appending "-dev" to whatever the current version is
(e.g. "0.2.0" becomes "0.2.0-dev"). This makes it easy to tell at a
glance whether a running instance is a development build.

Running setup again with dev mode off will strip the "-dev" suffix and
restore the base version automatically. Make sure dev mode is off before
committing changes or cutting a release — you don't want "0.2.0-dev"
shipping to users. You can also use vedit to set the version to anything
you like at any time.


Requirements
------------
Python 3.12 is required. Everything else is installed
automatically into a local virtual environment (tools/.venv) and won't
touch your system Python.

    Linux (Debian/Ubuntu):  sudo apt install python3.12 python3.12-venv
    Linux (Fedora):         sudo dnf install python3.12
    Windows:                https://python.org/downloads
                            (tick "Add Python to PATH" during install)

pip comes bundled with Python and is upgraded automatically on first run.
PyInstaller is only installed when you run build — it's not pulled in
for a normal launch.


Directory Layout
----------------
tools/
├── README.txt              ← you are here
├── requirements.txt        ← Python dependencies
├── build.txt               ← raw PyInstaller command, for reference
├── linux/
│   ├── setup.sh            ← START HERE (Linux/macOS)
│   ├── launch.sh
│   ├── dev.sh
│   ├── install_deps.sh
│   ├── build.sh
│   ├── clean.sh
│   └── vedit.sh
└── windows/
    ├── setup.bat           ← START HERE (Windows)
    ├── install_deps.bat
    ├── build.bat
    ├── clean.bat
    └── Vedit.bat
