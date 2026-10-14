; electron-builder 会自动包含本文件（directories.buildResources 默认 build/，无需在 package.json 配置）。
; 编译时 makensis 带 -INPUTCHARSET UTF8，所以这里可以直接写中文。
;
; 目的：让用户清楚"最终会装到 所选目录\Arxiver"。
;   - 官方目录页顶部补一行说明（见下面 ArxiverDirPagePre）：自定义安装会装到所选目录下的 Arxiver 子文件夹；
;   - 官方目录页之后插一个"安装位置确认"页，**只有用户改过目录时才会出现**
;     （没改就 Abort 跳过，不多点一次、不显示任何东西）。
;
; 安全性：本页只是"附加说明"页，任何异常都 Abort 跳过，退回 electron-builder 的默认流程；
;         而"补 \Arxiver"这步是幂等的（官方 instFilesPre 检测到路径里已含 Arxiver 就不会重复补），
;         所以无论本页跑没跑，最终安装位置都是 所选目录\Arxiver。
;
; ⚠️ 整个文件只在"安装器"那一遍编译时生效（下面一整块包在 !ifndef BUILD_UNINSTALLER 里）：
;   electron-builder 要编译两遍——先带 BUILD_UNINSTALLER 生成卸载器，再生成安装器，而本文件两遍都会被
;   include。页面命令（customPageAfterChangeDir）只在安装器那遍展开，所以这里定义的东西在卸载器那遍
;   就成了"定义了却没人引用"：makensis 会报 6010（函数）/ 6001（变量）警告，
;   而 electron-builder 带 -WX（警告即错误）——打包会直接失败。

!ifndef BUILD_UNINSTALLER

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; 允许把"安装位置"选到驱动器根目录（如 E:\）。NSIS 默认禁止（AllowRootDirInstall false），
; 选了根目录就会把"下一步"禁用——用户想"装到 E 盘"时很意外。
; 这里开着是安全的：electron-builder 总会追加应用名（本文件的 ArxiverNormalizeDir 与官方 instFilesPre
; 双保险），最终目录永远是 "<所选目录>\Arxiver"，卸载也只删这一层。
AllowRootDirInstall true

Var ArxiverDefaultDir
Var ArxiverConfirmDialog
Var ArxiverDirText

; 目录页顶部补一行提示：自定义安装位置时会装到"所选目录\Arxiver"下，点「下一步」能看到最终位置。
; 做法：MUI 的目录页正文支持变量（DirText 接受变量），把 MUI_DIRECTORYPAGE_TEXT_TOP 指向 $ArxiverDirText，
; 再在目录页的 PRE 回调（页面创建之前）里把"该语言自带的说明 + 我们的提示"写进去。
; 下面两个 !define 会被紧随其后的 MUI_PAGE_DIRECTORY 消费（MUI 用完即 !undef，不影响后面的页面）。
; 提示按语言给中/英两份：非中文一律英文，避免出现未定义的语言串。
!define MUI_DIRECTORYPAGE_TEXT_TOP "$ArxiverDirText"
!define MUI_PAGE_CUSTOMFUNCTION_PRE ArxiverDirPagePre

Function ArxiverDirPagePre
  ; $(^DirText) 就是目录页原本那段（含"单击下一步继续"），运行时按当前语言展开
  StrCpy $ArxiverDirText "$(^DirText)"
  ; 取主语言 ID：0x3FF 是低 10 位（zh-CN / zh-TW / zh-HK 都是 4 = Chinese）
  IntOp $0 $LANGUAGE & 0x3FF
  ${If} $0 == 4
    StrCpy $ArxiverDirText "$ArxiverDirText$\r$\n自定义安装会装到所选目录下的 Arxiver 子文件夹；点「下一步」查看最终位置。"
  ${Else}
    StrCpy $ArxiverDirText "$ArxiverDirText$\r$\nA custom folder gets an $\"Arxiver$\" subfolder inside it; click Next to see the final path."
  ${EndIf}
FunctionEnd

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

!endif
