@echo off
setlocal
REM Installs the relay runner as a Windows Startup item (relay-roadmap Plan 02's "always-on"
REM requirement) — creates a shortcut in the current user's Startup folder that launches
REM start-hidden.vbs (no visible console window) on every login. Safe to re-run after moving
REM the repo; it just overwrites the shortcut with the new path.

set RUNNER_DIR=%~dp0
set VBS_TARGET=%RUNNER_DIR%start-hidden.vbs
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT=%STARTUP_DIR%\relay-runner.lnk
set TMP_VBS=%TEMP%\relay-runner-install-%RANDOM%.vbs

> "%TMP_VBS%" echo Set oWS = WScript.CreateObject("WScript.Shell")
>> "%TMP_VBS%" echo sLinkFile = "%SHORTCUT%"
>> "%TMP_VBS%" echo Set oLink = oWS.CreateShortcut(sLinkFile)
>> "%TMP_VBS%" echo oLink.TargetPath = "%VBS_TARGET%"
>> "%TMP_VBS%" echo oLink.WorkingDirectory = "%RUNNER_DIR%"
>> "%TMP_VBS%" echo oLink.Description = "Relay runner (relay-roadmap Plan 02)"
>> "%TMP_VBS%" echo oLink.Save

cscript //nologo "%TMP_VBS%"
del "%TMP_VBS%" >nul 2>&1

echo Installed: %SHORTCUT%
echo It will start automatically on your next login.
echo To start it right now without logging out: double-click start-hidden.vbs
echo Logs: %%USERPROFILE%%\.relay\runner.log
endlocal
