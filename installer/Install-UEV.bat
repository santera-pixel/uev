@echo off
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -ClientMenu
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
)
if errorlevel 1 pause
