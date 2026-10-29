import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import type { AgentEvent, AgentChatRequest, Skill } from "../../shared/types";
import * as library from "../library";
import { runChat, modelConfigured, type ChatMessage, type ChatContentPart } from "./model";
import { toolDefs, runTool, isWriteTool, webSearchState, type ToolContext } from "./tools";
import * as skills from "./skills";

export type { AgentChatRequest };

const MAX_ROUNDS = 8;

// 历史消息带图时也要拼成内容块数组（图片只能出现在 user 消息里）
function contentWithImages(text: string, images?: string[]): string | ChatContentPart[] {
  if (!images || !images.length) { return text; }
  return [
    { type: "text", text: text || "(见下图)" },
    ...images.map((url): ChatContentPart => ({ type: "image_url", image_url: { url } }))
  ];
}

const SYSTEM_PROMPT = [
  "你是一个严谨的文献研究助手，帮助用户在本地文献库中检索、阅读并回答问题。",
  "你可以调用工具：list_library（浏览文库）、search_library（跨文献检索段落）、read_document（读取某篇文献正文）、search_in_document（单篇内检索），以及 search_web（联网搜索）与 fetch_url（读网页/PDF 正文）。联网能力是否可用，以【联网搜索】状态为准（每次请求都会给出）。",
  "工作方式：先检索/阅读相关证据，再基于证据作答；不要凭空编造。",
  "智能路由：系统会给出【用户当前正在阅读的文献】作为默认上下文。若问题没有指明其它文献（如“总结核心贡献/方法/局限”），默认针对这篇当前文献，直接用 read_document / search_in_document 处理，不要反问是哪一篇，也不要先全库扫描。只有问题明确涉及其它文献、跨文献对比或整库问题时，才用 search_library / list_library 去查找。",
  "联网搜索（search_web）：本地文库显然没有时（用户要找“最新的 / 别人的 / 某领域的 / 某会议的”资料）才用。要点：",
  "  · 一律用英文；先把用户的中文原话改写成 1~4 条**受控检索式**，多条一起传（queries 数组）扇出，不要只用一条模糊短词反复试。",
  "  · 加“锚点”大幅提升质量：会议/期刊名 + 年份（如 NeurIPS 2025、CVPR 2024、ICLR 2025），或 site: 限定（site:arxiv.org、site:openreview.net、site:openaccess.thecvf.com）。",
  "  · 加领域词消歧（如 floorplan reconstruction → “floorplan reconstruction neural network computer vision paper”），避免搜到建筑平面图、PCB 等无关领域。",
  "  · “最新”类问题带上 time_range（year / month），并优先看会议/期刊与 arXiv 的结果；结果偏旧或跑偏时，换更具体的检索式再查一次，而不是原样重试。",
  "  · 结果会以卡片展示给用户，可用卡片一键导入文库；回答里引用外部来源时给出链接，不要用 [[cite:…]]（那是本地文献的引用格式），也不要逐条复述摘要。",
  "  · 搜到候选后：若用户要的是**具体内容**（某篇怎么做、实验结论、对比这几篇），先用 fetch_url 读正文（优先 arXiv abs/PDF、OpenReview、会议 proceedings 页；每轮最多读 3 个），再基于正文回答；只列出候选清单时才不必读。**不要拿片段臆断方法细节与数字**。",
  "  · 用户追问“上一轮检索到 XX 了嘛”这类问题时，先核对历史消息里标注的【本轮外部检索结果卡片】（编号即 [[card:N]]）再回答：确实有就说清编号与标题；**没有就明确说没有检索到，必要时重新联网确认**。绝不因为用户这么说就附和“检索到了”——检索结果里没有的论文，不能当成检索到过。",
  "  · 用户问的是“上一轮那篇 XX 具体怎么做的”，可以直接 fetch_url 去读它的页面（不必要求用户先导入本地文库）；如果这篇值得长期用，再建议用户点卡片上的「导入到文库」。",
  "当信息不足、指代不清或需要用户决策时，主动向用户追问澄清，而不是臆测。",
  "用户可能用 @ 额外引用其它已打开的文献；这些文献会出现在【用户用 @ 额外引用的已打开文献】里，涉及它们时请用 read_document / search_in_document 读取并纳入分析。",
  "用户也可能随问题附上**图片**（PDF 区域截图或粘贴的图片）：直接依据图片内容回答，公式 / 图表 / 表格以图为准；不要声称看不到图片，也不要让用户重新输入图里的文字。",
  "写入操作（更新元数据、标签、星标/已读、移入回收站/恢复、加入或移出分类、改名/删除分类、增删笔记、把外部论文导入文库 import_paper）请直接调用对应工具：系统会先请用户批准，你无需再口头征询，直接调用即可。**不要声称自己没有这些能力**——用户让你导入论文、归类、加笔记、删分类，都用工具去做。",
  "导入与整理流水线：import_paper 拿到新文献 id 后，可继续 apply_tags / add_to_collection / add_note 等，完成「下载 → 归类 → 打标签 → 记笔记」这类多步操作；每一步都会单独请用户批准。",
  "技能（skills）：用户可以把常用的提示词 / 工作流程存成技能，之后在 AI 面板一键启用。技能库的元数据每轮都会给出；用户启用某个技能时，它的完整说明会注入【本次启用的技能】，按它执行（与其它要求冲突时以技能为准）。你也可以用 read_skill 读取任意技能的完整内容。",
  "  · 当用户说「把刚才这套做法存成技能」「以后都这样处理」「记住这个流程」，或者让你帮他建 / 改技能时，调用 save_skill：名称简短，description 写清什么时候用，instructions 写成以后可直接复用的通用步骤 / 提示词；不要把本次的具体文献标题、页码、一次性结果写死进去。要删技能用 delete_skill。这些写入都会先请用户批准。",
  "  · 用户没有手动启用技能、但请求明显匹配某个技能的 description 时，先用 read_skill 读取并照它执行，回答开头用一句话说明「按技能《…》处理」；拿不准时不要擅自套用。",
  "  · 如果用户只是第一次提出一个明显可复用的做法，先把任务做好；在回答末尾用一句话建议「可以存成技能」（不要主动调用 save_skill，除非用户同意或明确要求）。",
  "  · 用户给出的**分类名 / 标签名对不上**时（拼写差一点、记错了），先自己查：list_collections / list_library 看现有分类与标签，然后把最接近的候选直接摆出来让用户确认（如「库里没有 123124，最接近的是 124124，要删它吗？」）。**不要反过来要求用户去核对拼写**，也不要说「分类列表我这边没列出来」——你有 list_collections 工具。",
  "  · 指令有歧义或缺少信息时：先把**能确定的部分做完**（例如先把论文导入、先归类），再针对不确定的部分给出 A/B/C 这样的**具体可选项**并标明你的推荐（如「我建议 A：给这篇文献打标签 floorplan、reconstruction」）。不要只抛一个问题就停下，也不要臆测用户的意思。",
  "引用要求：每当陈述来自某段文献时，必须用 [[cite:文献id#页码|原文片段]] 标注来源（页码为 1 起）。片段是你所引用位置的一小段原文（约 10~60 字/词，从工具结果里**原样照抄**，不要改写、不要加省略号），前端会据此在 PDF 里定位并高亮该段；工具结果里已经给好的引用标记可直接复用，但若你引用的是同一段里的另一句，就把片段换成你实际引用的那句（仍从原文照抄）。确实无法摘出原文片段时才退回 [[cite:文献id#页码]]。",
  "回答语言跟随用户提问语言（默认中文）。可以适度使用 Markdown。"
].join("\n");

export class AgentService extends EventEmitter {
  private controllers = new Map<string, AbortController>();
  private confirmations = new Map<string, (decision: { approved: boolean; args?: string }) => void>();

  run(req: AgentChatRequest): { turnId: string } {
    // 渲染端可以指定 turnId（它会在发起请求前就记下来）。否则：未配置模型这类"立刻失败"的 run
    // 会在 invoke 返回之前就把 error 事件发出去，渲染端还没拿到 turnId → 事件被丢弃、界面一直转圈。
    const turnId = req.turnId || crypto.randomBytes(8).toString("hex");
    const controller = new AbortController();
    this.controllers.set(turnId, controller);
    void this.execute(turnId, req, controller.signal)
      .catch((err) => {
        // 用户主动取消：安静收尾（保留已经流出来的内容），不要弹一条红色的报错
        if (controller.signal.aborted) { this.emitEvent({ turnId, type: "done" }); return; }
        this.emitEvent({ turnId, type: "error", error: (err as Error)?.message || String(err) });
      })
      .finally(() => { this.controllers.delete(turnId); });
    return { turnId };
  }

  cancel(turnId: string): void {
    this.controllers.get(turnId)?.abort();
  }

  confirm(confirmId: string, decision: { approved: boolean; args?: string }): void {
    const resolve = this.confirmations.get(confirmId);
    if (resolve) { resolve(decision); }
  }

  private emitEvent(event: AgentEvent): void {
    this.emit("event", event);
  }

  private buildMessages(req: AgentChatRequest): ChatMessage[] {
    if (!modelConfigured()) {
      throw new Error("未配置模型：请在设置中填写 OpenAI 兼容的基础地址 / 密钥 / 模型");
    }
    const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
    for (const m of req.history || []) {
      messages.push({ role: m.role, content: contentWithImages(m.content, m.images) });
    }

    const ctx: string[] = [];
    if (req.docId) {
      const doc = library.getDocument(req.docId);
      ctx.push(`【用户当前正在阅读的文献（默认上下文）】《${doc ? doc.title : req.docId}》(id: ${req.docId})。若问题未指明具体文献，默认就是指这一篇。`);
    } else {
      ctx.push(`【对话范围】全库（用户未在阅读特定文献）`);
    }
    if (req.selection && req.selection.text.trim()) {
      ctx.push(`【用户选中的文本】第 ${req.selection.page} 页：“${req.selection.text.trim()}”`);
    }
    if (req.refs && req.refs.length) {
      const lines = req.refs.map((id) => { const d = library.getDocument(id); return `- ${id} 《${d ? d.title : id}》`; });
      ctx.push(`【用户用 @ 额外引用的已打开文献（可作为对比/补充证据，需要用 read_document / search_in_document 读取）】\n${lines.join("\n")}`);
    }
    // 技能库：把名称 / 说明给模型（方便判断该用哪个），启用的技能给完整说明
    const allSkills = skills.list();
    if (allSkills.length) {
      ctx.push(`【用户的技能库（可复用提示词 / 工作流程）】\n` +
        allSkills.map((s) => `- ${s.name}（id: ${s.id}）：${s.description || "（无说明）"}`).join("\n") +
        `\n需要某个技能的具体步骤时用 read_skill 读取；不要凭空猜技能内容。`);
    } else {
      ctx.push(`【用户的技能库】目前为空。用户若需要固定流程，可以建议他把做法存成技能，或用 save_skill 帮他创建。`);
    }
    const activeSkills = (req.skills || []).map((id) => skills.get(id)).filter((s): s is Skill => !!s);
    if (activeSkills.length) {
      ctx.push(`【本次启用的技能（用户已选择，按其中的步骤 / 要求执行；与一般习惯冲突时以技能为准）】\n` +
        activeSkills.map((s) => `## ${s.name}${s.description ? `（${s.description}）` : ""}\n${s.instructions}`).join("\n\n"));
    }
    // 联网能力的三态：别让模型把「缺 Key」猜成「没开启」，也别在不可用时编造外部资料
    const web = webSearchState();
    if (!web.on) {
      ctx.push("【联网搜索】未开启：search_web / fetch_url 都不可用。需要最新或外部资料时，如实说明并引导用户到 设置 → AI 服务 → 联网搜索 开启。");
    } else if (!web.key) {
      ctx.push(`【联网搜索】已开启，但服务商「${web.provider}」没有配置 API Key：search_web 不可用（fetch_url 仍可读用户给出的网页/PDF）。需要联网检索时，直接告诉用户去 设置 → AI 服务 → 联网搜索 填「${web.provider}」的 API Key；不要说你没有联网能力，也不要编造外部资料。`);
    } else {
      ctx.push(`【联网搜索】已开启（服务商：${web.provider}）：search_web 与 fetch_url 均可用。`);
    }
    const images = (req.images || []).filter((i) => i && i.dataUrl);
    if (images.length) {
      const lines = images.map((img, i) => {
        const where = img.page ? `PDF 第 ${img.page} 页` : "用户粘贴的图片";
        const pos = typeof img.anchor === "number"
          ? `，页面纵向约 ${Math.round(Math.max(0, Math.min(1, img.anchor)) * 100)}%`
          : "";
        const t = String(img.text || "").trim();
        return `- 图 ${i + 1}：${where}${pos}${t ? `\n  区域内文字（自动提取，可能有误差）：${t.slice(0, 600)}` : ""}`;
      });
      ctx.push(`【附加图片】用户附上了 ${images.length} 张图片，是 PDF 页面局部截图或用户粘贴的图片，可能包含公式、图表、表格：\n${lines.join("\n")}\n` +
        "优先依据图片本身回答；需要精确定位或核对小字时，用上面的页码 / 纵向位置 / 区域文字去对照（必要时 read_document 读该页上下文）。" +
        "不要声称看不到图片；引用图片里的内容时说明是「截图中的…」。");
    }
    ctx.push(`【用户问题】${req.message.trim() || "（用户没有额外输入，请按本次启用的技能执行）"}`);
    messages.push({ role: "user", content: contentWithImages(ctx.join("\n"), images.map((i) => i.dataUrl)) });
    return messages;
  }

  private async execute(turnId: string, req: AgentChatRequest, signal: AbortSignal): Promise<void> {
    const messages = this.buildMessages(req);
    const tools = toolDefs();
    // 卡片编号在整个对话里连续（渲染端把已有卡片数传进来），这样 [[card:13]] 永远指向同一篇
    let cardBase = req.cardBase || 0;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) { throw new Error("已取消"); }
      const result = await runChat({
        messages,
        tools,
        signal,
        onDelta: (text) => this.emitEvent({ turnId, type: "delta", text }),
        onReasoning: (text) => this.emitEvent({ turnId, type: "reasoning", text })
      });
      if (result.usage) { this.emitEvent({ turnId, type: "usage", usage: result.usage }); }

      if (result.toolCalls.length) {
        messages.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
        });
        for (const call of result.toolCalls) {
          this.emitEvent({ turnId, type: "tool_call", name: call.name, args: call.arguments });
          const ctx: ToolContext = {
            cardBase,
            emit: (e) => {
              if (e.type === "papers") { cardBase += e.papers.length; }
              this.emitEvent({ turnId, ...e });
            },
            progress: (text) => this.emitEvent({ turnId, type: "progress", name: call.name, text })
          };
          let output: string;
          if (isWriteTool(call.name)) {
            const confirmId = crypto.randomBytes(6).toString("hex");
            this.emitEvent({ turnId, type: "confirmation", confirmId, name: call.name, args: call.arguments });
            const decision = await new Promise<{ approved: boolean; args?: string }>((resolve) => { this.confirmations.set(confirmId, resolve); });
            this.confirmations.delete(confirmId);
            if (signal.aborted) { throw new Error("已取消"); }
            if (decision.approved) {
              output = await runTool(call.name, decision.args || call.arguments, ctx);
              if (call.name === "save_skill" || call.name === "delete_skill") {
                this.emitEvent({ turnId, type: "skills_changed" });
              } else {
                this.emitEvent({ turnId, type: "library_changed" });
              }
            } else {
              output = "用户拒绝执行该操作，请勿重复尝试；如需可询问用户希望的修改。";
            }
          } else {
            output = await runTool(call.name, call.arguments, ctx);
          }
          this.emitEvent({ turnId, type: "tool_result", name: call.name, content: output.slice(0, 4000) });
          messages.push({ role: "tool", tool_call_id: call.id, content: output.slice(0, 16000) });
        }
        continue;
      }

      this.emitEvent({ turnId, type: "done" });
      return;
    }
    this.emitEvent({ turnId, type: "delta", text: "\n\n（已达到最大工具调用轮数，回答可能不完整。）" });
    this.emitEvent({ turnId, type: "done" });
  }
}
