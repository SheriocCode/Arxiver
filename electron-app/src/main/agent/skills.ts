import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { skillsPath } from "../paths";
import type { Skill } from "../../shared/types";

// 技能库：用户可以把常用的提示词 / 工作流程存成技能，之后在 AI 面板一键启用。
// 只在本机保存（data/skills.json），不随会话或文献走。

const MAX_NAME = 80;
const MAX_DESC = 400;
const MAX_INSTRUCTIONS = 12000;
const MAX_SKILLS = 200;

type SkillInput = { id?: string; name?: string; description?: string; instructions?: string };

let cache: Skill[] | null = null;

function text(value: unknown, max: number): string {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function newId(): string {
  return "s" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
}

function normalize(raw: unknown): Skill | null {
  if (!raw || typeof raw !== "object") { return null; }
  const r = raw as Record<string, unknown>;
  const name = text(r.name, MAX_NAME);
  const instructions = text(r.instructions, MAX_INSTRUCTIONS);
  if (!name || !instructions) { return null; }
  const createdAt = Number(r.createdAt) || Date.now();
  return {
    id: text(r.id, 40) || newId(),
    name,
    description: text(r.description, MAX_DESC),
    instructions,
    createdAt,
    updatedAt: Number(r.updatedAt) || createdAt
  };
}

function load(): Skill[] {
  if (cache) { return cache; }
  cache = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(skillsPath(), "utf8"));
    if (Array.isArray(parsed)) {
      cache = parsed.map(normalize).filter((s): s is Skill => !!s);
    }
  } catch {
    // 首次运行 / 文件损坏：当作空技能库，下次保存时重建
  }
  return cache;
}

function saveFile(list: Skill[]): void {
  fs.mkdirSync(path.dirname(skillsPath()), { recursive: true });
  const tmp = skillsPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  fs.renameSync(tmp, skillsPath());
}

export function list(): Skill[] {
  // 最近更新的排在前面：刚让 AI 建好的技能一眼能看到
  return load().slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function get(idOrName: string): Skill | undefined {
  const key = String(idOrName || "").trim();
  if (!key) { return undefined; }
  const list = load();
  return list.find((s) => s.id === key)
    || list.find((s) => s.name.toLowerCase() === key.toLowerCase());
}

export function save(input: SkillInput): Skill {
  const name = text(input.name, MAX_NAME);
  const instructions = text(input.instructions, MAX_INSTRUCTIONS);
  if (!name) { throw new Error("技能名称不能为空"); }
  if (!instructions) { throw new Error("技能提示词不能为空"); }

  const list = load();
  const id = text(input.id, 40);
  // 指定了 id 就更新那一条；没给 id 但名称相同也视为更新，避免 AI 反复保存出重复技能
  const byId = id ? list.findIndex((s) => s.id === id) : -1;
  const byName = list.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
  if (byId >= 0 && byName >= 0 && byName !== byId) {
    throw new Error(`已有同名技能「${list[byName].name}」`);
  }
  const idx = byId >= 0 ? byId : byName;
  const now = Date.now();
  if (idx >= 0) {
    const next: Skill = {
      ...list[idx],
      name,
      description: text(input.description, MAX_DESC),
      instructions,
      updatedAt: now
    };
    list[idx] = next;
    saveFile(list);
    return next;
  }
  if (list.length >= MAX_SKILLS) { throw new Error(`技能数量已达上限（${MAX_SKILLS} 个），请先删除不用的技能`); }
  const created: Skill = {
    id: newId(),
    name,
    description: text(input.description, MAX_DESC),
    instructions,
    createdAt: now,
    updatedAt: now
  };
  list.push(created);
  saveFile(list);
  return created;
}

export function remove(idOrName: string): boolean {
  const skill = get(idOrName);
  if (!skill) { return false; }
  const list = load();
  const idx = list.findIndex((s) => s.id === skill.id);
  if (idx < 0) { return false; }
  list.splice(idx, 1);
  saveFile(list);
  return true;
}
