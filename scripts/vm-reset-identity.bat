@echo off
setlocal
rem Wipe the packaged Freedom app's identity vault + node data so the fresh
rem onboarding flow (issue #90 repro path) can be re-run between manual tests.
rem Data dir defaults to %APPDATA%\Freedom; pass a path as the first arg to
rem override (e.g. for a different user profile or a portable build).
if "%~1"=="" (
  set "DATA=%APPDATA%\Freedom"
) else (
  set "DATA=%~1"
)

echo Target data dir: %DATA%

echo === Killing app + node processes ===
taskkill /F /IM Freedom.exe /T
taskkill /F /IM antd.exe /T
taskkill /F /IM ipfs.exe /T

echo === Waiting for handles to release ===
ping -n 4 127.0.0.1 >nul

echo === Deleting identity + node data ===
rmdir /S /Q "%DATA%\identity"
rmdir /S /Q "%DATA%\ant-data"
rmdir /S /Q "%DATA%\ipfs-data"

echo === Remaining contents of Freedom data dir ===
dir "%DATA%"
endlocal
