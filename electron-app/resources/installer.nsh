; 安装包接近 1.8 GB，NSIS 默认启动时会逐块做 CRC 校验（界面上的
; “verifying installer”），在机械硬盘或杀毒软件扫描时可能多等几十秒。
; 下载完整性由发布页的 SHA256SUMS 保证，这里跳过安装器启动时的整包校验，
; 让双击后尽快出现安装界面。
CRCCheck off

; 数据目录（<安装目录>\data）保存文库、翻译、模型、配置和 Chromium 缓存。
; 升级 / 卸载时不要跟着应用文件一起删除，否则用户资料会丢。
!macro customRemoveFiles
  SetOutPath "$TEMP"
  FindFirst $R8 $R9 "$INSTDIR\*.*"
  customRemoveFilesLoop:
    StrCmp $R9 "" customRemoveFilesDone
    StrCmp $R9 "." customRemoveFilesNext
    StrCmp $R9 ".." customRemoveFilesNext
    StrCmp $R9 "data" customRemoveFilesNext
    IfFileExists "$INSTDIR\$R9\*.*" 0 customRemoveFilesDelete
    RMDir /r "$INSTDIR\$R9"
    Goto customRemoveFilesNext
  customRemoveFilesDelete:
    Delete "$INSTDIR\$R9"
  customRemoveFilesNext:
    FindNext $R8 $R9
    Goto customRemoveFilesLoop
  customRemoveFilesDone:
    FindClose $R8
!macroend
