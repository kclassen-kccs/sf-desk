@echo off
rem Installs (or updates) SF Desk for the current user. Double-click it after unzipping the download.
rem No admin rights needed. Your settings, Salesforce login and local data are kept.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\windows\install.ps1" -From "%~dp0."
if errorlevel 1 pause
