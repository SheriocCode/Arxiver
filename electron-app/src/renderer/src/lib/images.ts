// 图片进入对话前的统一处理：限制最长边并转成 JPEG，控制请求体大小
// （视觉接口按图片尺寸折算 token，超大图既慢又贵；JPEG 对截图/公式足够清晰）。

const MAX_SIDE = 1600;

export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

export async function normalizeImage(dataUrl: string, maxSide = MAX_SIDE, quality = 0.9): Promise<string> {
  if (!dataUrl) { return ""; }
  const img = await loadImage(dataUrl);
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) { return dataUrl; }
  // 已经是压缩过的 JPEG 截图且尺寸不大：不再二次编码，少一次画质损失
  if (/^data:image\/jpeg/i.test(dataUrl) && Math.max(w0, h0) <= maxSide && dataUrl.length < 400_000) { return dataUrl; }
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) { return dataUrl; }
  // JPEG 没有透明通道：先铺白底，避免透明区域变黑
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  try {
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return dataUrl;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = src;
  });
}
