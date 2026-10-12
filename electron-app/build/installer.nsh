; electron-builder 会自动包含本文件（directories.buildResources 默认 build/，无需在 package.json 配置）。
; 编译时 makensis 带 -INPUTCHARSET UTF8，所以这里可以直接写中文。
;
; 目的：让用户清楚"最终会装到 所选目录\Arxiver"，又不打扰用默认目录的人。
;   - 官方目录选择页不再显示任何提示文字（默认路径下保持干净）；
;   - 官方目录页之后插一个"安装位置确认"页，**只有用户改过目录时才会出现**
;     （没改就 Abort 跳过，不多点一次、不显示任何东西）。
;
; 安全性：本页只是"附加说明"页，任何异常都 Abort 跳过，退回 electron-builder 的默认流程；
;         而"补 \Arxiver"这步是幂等的（官方 instFilesPre 检测到路径里已含 Arxiver 就不会重复补），
;         所以无论本页跑没跑，最终安装位置都是 所选目录\Arxiver。

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var ArxiverDefaultDir
Var ArxiverConfirmDialog

; customInit 在 initMultiUser 之后执行，所以此时 $INSTDIR 已经是最终默认目录
; （每用户：%LOCALAPPDATA%\Programs\Arxiver；所有用户：C:\Program Files\Arxiver；
;  升级或带 /D 参数时：注册表/参数里的值）。
!macro customInit
  StrCpy $ArxiverDefaultDir "$INSTDIR"
!macroend

; 目录选择页之后、开始安装之前插页（该钩子不受 allowToChangeInstallationDirectory 影响）。
!macro customPageAfterChangeDir
  Page custom ArxiverDirConfirmCreate ArxiverDirConfirmLeave
!macroend

; 把 $INSTDIR 规范化为 "<目录>\Arxiver"（幂等）：去掉末尾多余反斜杠；最后一段不是 Arxiver 才补。
; 单独成函数是为了能脱离 UI 单独测试。
Function ArxiverNormalizeDir
  ${Do}
    StrCpy $2 "$INSTDIR" "" -1
    ${If} $2 != "\"
      ${ExitDo}
    ${EndIf}
    StrCpy $INSTDIR "$INSTDIR" -1
  ${Loop}
  StrLen $3 "${APP_FILENAME}"
  StrCpy $4 "$INSTDIR" "" -$3
  ${If} "$4" != "${APP_FILENAME}"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
FunctionEnd

; 页面函数放在 customHeader 里定义：该宏在 installer.nsi 中于 MUI2.nsh 之后展开，
; 只有这样才能用 MUI_HEADER_TEXT（在文件顶部展开时 MUI2 还没被 include）。
; customHeader 的展开位置在 customPageAfterChangeDir 之后，NSIS 允许函数前向引用。
!macro customHeader
  Function ArxiverDirConfirmCreate
    ; 没改过目录 → 跳过本页（StrCmp 不区分大小写）
    ${If} "$INSTDIR" == "$ArxiverDefaultDir"
      Abort
    ${EndIf}

    Call ArxiverNormalizeDir

    !insertmacro MUI_HEADER_TEXT "安装位置" "确认 Arxiver 的安装文件夹"

    nsDialogs::Create 1018
    Pop $ArxiverConfirmDialog
    ${If} $ArxiverConfirmDialog == error
      ; 自绘失败就跳过本页，绝不阻塞安装
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 4u 100% 12u "Arxiver 将安装到："
    Pop $0
    ${NSD_CreateLabel} 0 24u 100% 12u "$INSTDIR"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function ArxiverDirConfirmLeave
  FunctionEnd
!macroend
