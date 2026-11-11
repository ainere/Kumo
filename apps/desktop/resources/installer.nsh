; Added to electron-builder's NSIS script (nsis.include in electron-builder.yml).

; The installer keeps a copy of itself in %LOCALAPPDATA%\kumo-updater as the
; base for differential updates, and electron-updater downloads into the same
; folder. electron-builder's uninstaller leaves it behind, about the size of
; the installer, so a real uninstall removes it here. An update also runs the
; old uninstaller, with --updated, and keeps it. The name comes from the
; packaged name, "kumo" (extraMetadata), plus "-updater".
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\kumo-updater"
  ${endIf}
!macroend
