!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var CyreneDesktopShortcutCheckbox
Var CyreneLaunchAtLoginCheckbox
Var CyreneCreateDesktopShortcut
Var CyreneLaunchAtLogin

!macro customPageAfterChangeDir
  Page custom CyreneOptionsPageCreate CyreneOptionsPageLeave
!macroend

Function CyreneOptionsPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "安装选项"
  Pop $0

  ${NSD_CreateCheckbox} 0 34u 100% 12u "创建桌面快捷方式"
  Pop $CyreneDesktopShortcutCheckbox
  ${NSD_Check} $CyreneDesktopShortcutCheckbox

  ${NSD_CreateCheckbox} 0 56u 100% 12u "开机时自动启动 Cyrene"
  Pop $CyreneLaunchAtLoginCheckbox
  ${NSD_Uncheck} $CyreneLaunchAtLoginCheckbox

  nsDialogs::Show
FunctionEnd

Function CyreneOptionsPageLeave
  ${NSD_GetState} $CyreneDesktopShortcutCheckbox $CyreneCreateDesktopShortcut
  ${NSD_GetState} $CyreneLaunchAtLoginCheckbox $CyreneLaunchAtLogin
FunctionEnd

!macro customInstall
  ${If} $CyreneCreateDesktopShortcut == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${EndIf}

  CreateShortCut "$SMPROGRAMS\${MENU_FILENAME}\卸载 ${PRODUCT_FILENAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0

  ${If} $CyreneLaunchAtLogin == ${BST_CHECKED}
    CreateDirectory "$APPDATA\${APP_PACKAGE_NAME}"
    FileOpen $0 "$APPDATA\${APP_PACKAGE_NAME}\installer-options.json" w
    FileWrite $0 "{$\"launchAtLogin$\":true}"
    FileClose $0
  ${Else}
    CreateDirectory "$APPDATA\${APP_PACKAGE_NAME}"
    FileOpen $0 "$APPDATA\${APP_PACKAGE_NAME}\installer-options.json" w
    FileWrite $0 "{$\"launchAtLogin$\":false}"
    FileClose $0
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  Delete "$SMPROGRAMS\${MENU_FILENAME}\卸载 ${PRODUCT_FILENAME}.lnk"
!macroend
