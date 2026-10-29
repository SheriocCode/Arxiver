import type { AiConnectionTestResult } from "../shared/types";

/** 用 /models 做一次轻量连通性检查；不发送任何聊天内容。 */
export async function testConnection(input: { baseUrl?: string; apiKey?: string }): Promise<AiConnectionTestResult> {
  const base = String(input?.baseUrl || "").trim().replace(/\/+$/, "");
  const key = String(input?.apiKey || "").trim();
  if (!base) { return { ok: false, message: "请先填写接口地址" }; }
  if (!key) { return { ok: false, message: "请先填写 API Key" }; }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(base + "/models", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal
    });
    const latencyMs = Date.now() - started;
    if (res.ok) {
      let count = 0;
      try {
        const data = await res.json() as { data?: unknown[] };
        count = Array.isArray(data?.data) ? data.data.length : 0;
      } catch {
        /* 有的服务商不返回 JSON，连通即可 */
      }
      return { ok: true, message: count ? `连接正常，可用模型 ${count} 个` : "连接正常", latencyMs };
    }
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      message: `HTTP ${res.status}${text ? "：" + text.replace(/\s+/g, " ").slice(0, 160) : ""}`,
      latencyMs
    };
  } catch (error) {
    const name = (error as Error)?.name;
    const message = name === "AbortError" ? "连接超时（12 秒）" : ((error as Error)?.message || String(error));
    return { ok: false, message, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
