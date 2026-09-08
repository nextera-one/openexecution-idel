@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "EXT_PUBLISHER=nextera-one"
set "EXT_NAME=openexecution-idel-vscode"
set "EXT_VERSION=0.1.0"
set "EXT_FOLDER=%EXT_PUBLISHER%.%EXT_NAME%-%EXT_VERSION%"

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fI"
set "EXT_SRC=%ROOT_DIR%\packages\vscode-extension"

if not exist "%EXT_SRC%\package.json" (
  echo Could not find VS Code extension source at: %EXT_SRC% 1>&2
  exit /b 1
)

if "%VSCODE_EXTENSIONS_DIR%"=="" (
  set "TARGET_BASE=%USERPROFILE%\.vscode\extensions"
) else (
  set "TARGET_BASE=%VSCODE_EXTENSIONS_DIR%"
)

set "TARGET_DIR=%TARGET_BASE%\%EXT_FOLDER%"
set "TMP_DIR=%TARGET_BASE%\.%EXT_FOLDER%.tmp"
set "NODE_BIN="

echo Installing OpenExecution IDEL VS Code extension...
echo Source: %EXT_SRC%
echo Target: %TARGET_DIR%

if not exist "%TARGET_BASE%" mkdir "%TARGET_BASE%"
if exist "%TMP_DIR%" rmdir /s /q "%TMP_DIR%"
mkdir "%TMP_DIR%"

copy /y "%EXT_SRC%\package.json" "%TMP_DIR%\package.json" >nul
copy /y "%EXT_SRC%\README.md" "%TMP_DIR%\README.md" >nul
xcopy /e /i /y "%EXT_SRC%\src" "%TMP_DIR%\src" >nul
xcopy /e /i /y "%EXT_SRC%\resources" "%TMP_DIR%\resources" >nul

for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_BIN set "NODE_BIN=%%I"
if not defined NODE_BIN for /f "delims=" %%I in ('where nodejs 2^>nul') do if not defined NODE_BIN set "NODE_BIN=%%I"
if not defined NODE_BIN if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE_BIN=%NVM_SYMLINK%\node.exe"
if not defined NODE_BIN if defined NVM_HOME if exist "%NVM_HOME%\current\node.exe" set "NODE_BIN=%NVM_HOME%\current\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if defined NODE_BIN (
  set "NODE_JSON=%NODE_BIN:\=/%"
  > "%TMP_DIR%\node-path.json" echo {
  >> "%TMP_DIR%\node-path.json" echo   "nodePath": "!NODE_JSON!"
  >> "%TMP_DIR%\node-path.json" echo }
  echo Detected Node: !NODE_BIN!
) else (
  echo Warning: Node was not found. Set openexecutionIdel.nodePath in VS Code if the extension cannot start. 1>&2
)

if exist "%TARGET_DIR%" rmdir /s /q "%TARGET_DIR%"
move "%TMP_DIR%" "%TARGET_DIR%" >nul

echo.
echo Installed: %TARGET_DIR%
echo Reload VS Code, then run: IDEL: Open Terminal
echo.
echo To install into another VS Code-compatible profile, set VSCODE_EXTENSIONS_DIR.

endlocal
