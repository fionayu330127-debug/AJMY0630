@echo off
chcp 65001 >nul
set "NODE=C:\Program Files\nodejs\node.exe"
set "ERP_DIR=C:\Users\Administrator\Desktop\agimia-erp-shell"

start "奥吉米亚 ERP" /min "%NODE%" "%ERP_DIR%\server.js"

echo 奥吉米亚 ERP: http://127.0.0.1:3002/
echo TK 达人管理系统: http://127.0.0.1:3002/tk/
pause
