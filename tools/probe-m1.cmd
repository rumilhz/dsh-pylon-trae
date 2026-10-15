@echo off
rem ===========================================================================
rem M1 probe launcher -- READ ONLY. ASCII only on purpose: a batch file that
rem carries non-ASCII bytes makes cmd.exe complain depending on the console
rem code page, even when the command itself would have worked.
rem
rem Usage:
rem   probe-m1.cmd                  paths + credentials + live model directory
rem   probe-m1.cmd --no-network     paths + credentials only (no HTTP at all)
rem
rem It uses the DSH runtime node when present (the Node this profile is known to
rem run) and otherwise falls back to `node` from PATH.
rem ===========================================================================
setlocal
set "HERE=%~dp0"
set "NODE=node"
set "DSHNODE=<dsh-node>"
if exist "%DSHNODE%" set "NODE=%DSHNODE%"
"%NODE%" "%HERE%probe-m1.ts" %*
exit /b %ERRORLEVEL%
