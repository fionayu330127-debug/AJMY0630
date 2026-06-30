@echo off
chcp 65001 >nul
set "NODE=C:\Program Files\nodejs\node.exe"
set "ERP_DIR=C:\Users\Administrator\Desktop\agimia-erp-shell"
set "PORT=3001"

start "agimia-erp-shell" /D "%ERP_DIR%" /min "%ComSpec%" /c call "%ERP_DIR%\run-server.bat"

echo Agimia ERP: http://127.0.0.1:3001/
echo TK creator system: http://127.0.0.1:3001/tk/
