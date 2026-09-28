@echo off
rem 開発中の TM Viewer を起動する（配布用の exe ができるまでの仮の起動ファイル）
cd /d "%~dp0"
start "" /b cmd /c "npm start"
