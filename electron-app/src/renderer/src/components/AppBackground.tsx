import type { JSX } from "react";

const VIDEO_EXT = /\.(mp4|webm|mov|mkv)$/i;

// 用户自选的界面背景：图片或视频（视频自动静音循环播放）。
// 文件由主进程的 arxiver-bg:// 协议提供，放在界面最底层（z-index:-1）。
export default function AppBackground({ file }: { file: string }): JSX.Element {
  const src = "arxiver-bg://bg/" + encodeURIComponent(file);
  return (
    <div className="app-bg" aria-hidden="true">
      {VIDEO_EXT.test(file)
        ? <video className="app-bg-media" src={src} autoPlay muted loop playsInline disablePictureInPicture />
        : <img className="app-bg-media" src={src} alt="" />}
    </div>
  );
}
