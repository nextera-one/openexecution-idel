@echo off
setlocal EnableExtensions

set "EXT_PUBLISHER=nextera-one"
set "EXT_NAME=openexecution-idel-vscode"
set "EXT_VERSION=0.2.0"
set "EXT_FOLDER=%EXT_PUBLISHER%.%EXT_NAME%-%EXT_VERSION%"
set "PREVIOUS_EXT_FOLDER=%EXT_PUBLISHER%.%EXT_NAME%-0.1.0"

if "%VSCODE_EXTENSIONS_DIR%"=="" (
  set "TARGET_BASE=%USERPROFILE%\.vscode\extensions"
) else (
  set "TARGET_BASE=%VSCODE_EXTENSIONS_DIR%"
)

set "TARGET_DIR=%TARGET_BASE%\%EXT_FOLDER%"
set "TMP_DIR=%TARGET_BASE%\.%EXT_FOLDER%.tmp"
set "PREVIOUS_TARGET=%TARGET_BASE%\%PREVIOUS_EXT_FOLDER%"

echo Uninstalling OpenExecution IDEL VS Code extension...
echo Target: %TARGET_DIR%

if exist "%TMP_DIR%" rmdir /s /q "%TMP_DIR%"

if not exist "%TARGET_DIR%" if not exist "%PREVIOUS_TARGET%" (
  echo.
  echo Nothing to remove. Extension was not found at: %TARGET_DIR%
  exit /b 0
)

rmdir /s /q "%TARGET_DIR%"
if exist "%PREVIOUS_TARGET%" rmdir /s /q "%PREVIOUS_TARGET%"

echo.
echo Removed: %TARGET_DIR%
echo Reload VS Code to finish uninstalling the extension.
echo.
echo To uninstall from another VS Code-compatible profile, set VSCODE_EXTENSIONS_DIR.

endlocal
