import { useEffect, useRef, useState, type JSX } from "react";

// 启动动画：在 App 窗口内铺一层遮罩播放皮肤视频，放完（或点击 / 出错 / 超时）后淡出。
// 视频放在 renderer 的 public/ 下，dev 与安装版都按相对路径加载。
const VIDEO_SRC = "skin_deepseek.mp4";
const FADE_MS = 420;

export default function SplashScreen(): JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [fading, setFading] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let timeout = 0;
    const finish = (): void => {
      setFading(true);
      window.setTimeout(() => setGone(true), FADE_MS);
    };
    const video = videoRef.current;
    if (!video) { finish(); return; }
    video.addEventListener("ended", finish);
    video.addEventListener("error", finish);
    timeout = window.setTimeout(finish, 15000);
    video.play().catch(() => { timeout = window.setTimeout(finish, 900); });
    return () => {
      window.clearTimeout(timeout);
      video.removeEventListener("ended", finish);
      video.removeEventListener("error", finish);
    };
  }, []);

  if (gone) { return null; }

  return (
    <div
      className={"splash-screen" + (fading ? " is-fading" : "")}
      onClick={() => { setFading(true); window.setTimeout(() => setGone(true), FADE_MS); }}
    >
      <video ref={videoRef} src={VIDEO_SRC} autoPlay muted playsInline disablePictureInPicture />
      <span className="splash-skip">点击跳过</span>
    </div>
  );
}
