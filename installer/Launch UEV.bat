@echo off
setlocal EnableExtensions
set "PROJECT=%~1"
if "%PROJECT%"=="" set /p "PROJECT=Project folder (not .uproject), e.g. D:\Uprojects\mcptest2: "
if "%PROJECT%"=="" (
  echo No project folder supplied.
  pause
  exit /b 1
)
set "PROJECT=%PROJECT:"=%"
if /I "%PROJECT:~-9%"==".uproject" for %%I in ("%PROJECT%") do set "PROJECT=%%~dpI"
if "%PROJECT:~-1%"=="\" set "PROJECT=%PROJECT:~0,-1%"
set "LAUNCHER=%PROJECT%\Saved\UEV\run-stack.ps1"
if not exist "%LAUNCHER%" (
  echo No installed stack launcher found at "%LAUNCHER%".
  echo Run install.bat for that project first.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" %2 %3 %4 %5
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" pause
exit /b %EXITCODE%
