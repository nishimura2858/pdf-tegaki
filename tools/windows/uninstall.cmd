@echo off
rem Word -> PDF auto converter: uninstall
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\word-to-pdf.vbs" 2>nul
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*word-to-pdf.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo.
echo  OK: stopped and removed from startup.
echo.
pause
