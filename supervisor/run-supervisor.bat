@echo off
setlocal
cd /d "%~dp0"

set "SUPERVISOR=bin\Release\net9.0\UEVSupervisor.exe"
if not exist "%SUPERVISOR%" (
  echo Building supervisor...
  dotnet build -c Release
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
)

"%SUPERVISOR%" --editor "D:\UE-ViteFork\Engine\Binaries\Win64\UE4Editor.exe" --project "D:\Uprojects\ViteMCPTest\ViteMCPTest.uproject" --pipe "uev-supervisor" %*
set "EXITCODE=%ERRORLEVEL%"
echo.
echo Supervisor exited with code %EXITCODE%.
pause
exit /b %EXITCODE%
