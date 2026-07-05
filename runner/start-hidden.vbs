' Launches start.bat with no visible console window — this is what the Startup-folder shortcut
' (see install-startup.bat) actually points at, so logging in doesn't pop a black CMD window.
' The runner's own output still goes to ~/.relay/runner.log (see relay-runner.mjs's log()).
Set objShell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
objShell.Run """" & scriptDir & "\start.bat""", 0, False
