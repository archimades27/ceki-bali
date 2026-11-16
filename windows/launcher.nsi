Unicode True
Name "Ceki Bali"
OutFile "${OUT_EXE}"
Icon "${ICON_FILE}"
SilentInstall silent
RequestExecutionLevel user
ShowInstDetails nevershow

Section ""
  Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$EXEDIR\CekiBali.ps1"'
SectionEnd
