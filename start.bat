@echo off
cd /d "%~dp0"
title Scalp Lab - DEMO trading (keep this window open)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
