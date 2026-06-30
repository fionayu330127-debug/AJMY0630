@echo off
cd /d "%~dp0"
set "PORT=3001"
"C:\Program Files\nodejs\node.exe" server.js > erp.out.log 2> erp.err.log
