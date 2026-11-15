@echo off
rem Word -> PDF auto converter: install (runs at Windows sign-in)
setlocal
set "DEST=%ProgramData%\word-to-pdf"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
rem stop the old one (if running) so the new version starts
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*word-to-pdf.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%~dp0word-to-pdf.ps1" "%DEST%\word-to-pdf.ps1" >nul
if errorlevel 1 goto fail
> "%STARTUP%\word-to-pdf.vbs" echo CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""%DEST%\word-to-pdf.ps1""", 0, False
if errorlevel 1 goto fail
wscript "%STARTUP%\word-to-pdf.vbs"
echo.
echo  OK: installed. It is running now and will start automatically when Windows starts.
echo  Log: %DEST%\log.txt
echo.
pause
exit /b 0
:fail
echo.
echo  Failed. Please send a screenshot of this window.
pause
exit /b 1
