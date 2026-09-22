@echo off
setlocal
node "%~dp0bin\c2c.js" connect-all
exit /b %ERRORLEVEL%
