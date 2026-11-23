@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0windows\Setup.ps1" %*
if errorlevel 1 (
  echo Setup failed.
  pause
  exit /b 1
)
echo Done.
pause
