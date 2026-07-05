@echo off
REM Starts the relay runner daemon under plain node (see bin/relay-runner.mjs's header for why
REM not bun). %~dp0 is this script's own directory (runner/), so this resolves correctly no
REM matter where the repo is checked out or what the current working directory is when a
REM shortcut/Startup-folder entry launches it.
node "%~dp0..\bin\relay-runner.mjs"
