@echo off
setlocal
"__FLEET_NODE__" "__FLEET_CONSOLE__" %*
exit /b %ERRORLEVEL%
