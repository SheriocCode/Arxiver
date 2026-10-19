; 安装包接近 1.8 GB，NSIS 默认启动时会逐块做 CRC 校验（界面上的
; “verifying installer”），在机械硬盘或杀毒软件扫描时可能多等几十秒。
; 下载完整性由发布页的 SHA256SUMS 保证，这里跳过安装器启动时的整包校验，
; 让双击后尽快出现安装界面。
CRCCheck off
