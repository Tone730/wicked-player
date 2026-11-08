' Wicked Player watchdog (v6 - truthful probe via hidden PowerShell)
' Probe = Invoke-WebRequest exit code (0 = up, 1 = down), run window-hidden.
' Bounce = schtasks /end + /run on the backend task. No WMI anywhere.
On Error Resume Next

Const BDIR = "C:\Users\Leakz\Documents\Default Project\wicked-backend"

Sub LogLine(msg)
    Dim fso, f
    Set fso = CreateObject("Scripting.FileSystemObject")
    Set f = fso.OpenTextFile(BDIR & "\backend.log", 8, True)
    If Err.Number <> 0 Then Err.Clear : Exit Sub
    f.WriteLine "[" & Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) & "T" & FormatDateTime(Now, vbShortTime) & "] " & msg
    f.Close
    Set f = Nothing
    Set fso = Nothing
End Sub

Dim sh
Set sh = CreateObject("WScript.Shell")

' probe: exit code 0 = app answers, 1 = down
Dim probeCmd : probeCmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command ""try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:5000/api/status' -UseBasicParsing -TimeoutSec 4; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 } "" "

Dim ok : ok = False
Dim i, rc
For i = 1 To 3
    rc = sh.Run(probeCmd, 0, True)
    If rc = 0 Then
        ok = True
        Exit For
    End If
    LogLine "watchdog: probe " & i & " failed (rc=" & rc & ")"
    WScript.Sleep 1500
Next

If ok Then WScript.Quit

LogLine "watchdog: app not answering - bouncing backend task"
sh.Run "schtasks /end /tn ""WickedPlayer Backend"" /f", 0, True
Err.Clear
WScript.Sleep 800
sh.Run "schtasks /run /tn ""WickedPlayer Backend""", 0, True
If Err.Number <> 0 Then LogLine "watchdog: bounce error " & Err.Number
Set sh = Nothing
