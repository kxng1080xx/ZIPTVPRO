; NSIS include for the one-click installer (referenced from package.json
; build.nsis.include). Closes any running ZIPTV Pro instance before
; install/update so electron-updater's silent update never hits locked files.
!macro customInit
  nsExec::Exec 'taskkill /F /IM "ZIPTV Pro.exe"'
!macroend
