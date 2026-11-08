' Wicked Player - detached backend starter
' Starts node server.js via WMI so it escapes the scheduled-task job object
' and keeps running after this script (and its parent task) exits.
Dim wmi, proc, pidOut, result
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set proc = wmi.Get("Win32_Process")
result = proc.Create( _
    "cmd /c cd /d ""C:\Users\Leakz\Documents\Default Project\wicked-backend"" && node server.js >> backend.log 2>&1", _
    "C:\Users\Leakz\Documents\Default Project\wicked-backend", _
    Nothing, pidOut)

If result = 0 Then
    ' started, pid in pidOut
Else
    Dim fso, f
    Set fso = CreateObject("Scripting.FileSystemObject")
    Set f = fso.OpenTextFile("C:\Users\Leakz\Documents\Default Project\wicked-backend\backend.log", 8, True)
    f.WriteLine "[" & Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) & "T" & FormatDateTime(Now, vbShortTime) & "] start error WMI code " & result
    f.Close
End If
