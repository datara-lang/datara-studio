' scripts/hidden.vbs - launch a command with no visible window.
'
' Why this exists: `start "title" cmd /c "..."` always creates a console window.
' `/min` only minimises it, so it still appears in the taskbar and still flashes
' on the way past. There is no flag on `start` that means "hidden" - the only
' reliable way to get a window that never appears is to ask the shell to create
' the process with a hidden window station, which is what WshShell.Run's second
' argument (0) does.
'
' Usage:  wscript //nologo //B scripts\hidden.vbs "cmd /c ..."
'         //B = batch mode, so a script error does not pop a dialog either.
'
' The process is not waited for: the launcher's watchdog is what keeps it alive.

Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count = 0 Then
    WScript.Quit 1
End If

cmd = WScript.Arguments(0)
workdir = ""
If WScript.Arguments.Count > 1 Then
    workdir = WScript.Arguments(1)
End If

' 0 = hidden window, False = do not wait for it to finish
If Len(workdir) > 0 Then
    sh.CurrentDirectory = workdir
End If
sh.Run cmd, 0, False
