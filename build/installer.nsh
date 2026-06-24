; Custom NSIS hooks for termi (auto-included by electron-builder).
; After (re)install, force the Windows shell to refresh its icon cache so the
; desktop/taskbar shortcut picks up the current app icon even when the exe is
; reinstalled to the same path.

!macro customInstall
  ; SHCNE_ASSOCCHANGED (0x08000000) — tells Explorer to flush icon/association cache
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ; extra nudge on Win10/11
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend

!macro customUnInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
