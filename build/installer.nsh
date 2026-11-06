; NSIS include for the one-click installer (referenced from package.json
; build.nsis.include). Closes any running ZIPTV Pro instance before
; install/update so electron-updater's silent update never hits locked files.
;
; /T kills the whole process tree: a bare /F on the main exe skips the app's
; before-quit cleanup and orphans its ffmpeg/cloudflared children.
!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "ZIPTV Pro.exe"'
!macroend

; Replaces electron-builder's check, which treats ANY process whose path is under
; $INSTDIR as "app running" but only ever kills ZIPTV Pro.exe — so a leftover
; resources\bin\ffmpeg.exe or cloudflared.exe made it loop on
; "ZIPTV Pro cannot be closed". Kill everything running from the install dir.
!macro customCheckAppRunning
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -C "Get-CimInstance Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  ; let Windows release file handles before files are overwritten
  Sleep 800
!macroend
