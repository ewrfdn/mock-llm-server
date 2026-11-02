import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

export const SKILL_NAME = "mock-llm-server";
const SKILLS_ROOT = path.resolve(config.skillsDir);
const DEFAULT_ROOT = path.join(SKILLS_ROOT, SKILL_NAME);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function safeSkillRoot(name) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(name || ""))) {
    throw new AppError(400, "invalid_skill_name", "非法 Skill 名称");
  }
  const root = path.resolve(SKILLS_ROOT, name);
  if (root !== SKILLS_ROOT && !root.startsWith(`${SKILLS_ROOT}${path.sep}`)) {
    throw new AppError(400, "invalid_skill_name", "非法 Skill 名称");
  }
  return root;
}

export function listSkills() {
  if (!fs.existsSync(SKILLS_ROOT)) return [];
  return fs
    .readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .filter((entry) => fs.existsSync(path.join(SKILLS_ROOT, entry.name, "SKILL.md")))
    .map((entry) => entry.name);
}

export function readSkill(name = SKILL_NAME) {
  const root = safeSkillRoot(name);
  const file = path.join(root, "SKILL.md");
  if (!fs.existsSync(file)) throw new AppError(404, "skill_not_found", `Skill ${name} 不存在`);
  return fs.readFileSync(file, "utf8");
}

function collectFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === "node_modules") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  walk(root);
  return files.sort();
}

export function skillFiles(name = SKILL_NAME) {
  const root = safeSkillRoot(name);
  if (!fs.existsSync(path.join(root, "SKILL.md"))) throw new AppError(404, "skill_not_found", `Skill ${name} 不存在`);
  return collectFiles(root).map((absolute) => ({
    absolute,
    relative: path.relative(root, absolute).split(path.sep).join("/"),
  }));
}

function writeUInt16(buffer, value, offset) {
  buffer.writeUInt16LE(value & 0xffff, offset);
}

/** 生成 store（不压缩）方式的 ZIP，避免引入额外依赖。 */
export function skillArchive(name = SKILL_NAME) {
  const root = safeSkillRoot(name);
  const files = skillFiles(name);
  if (!files.length) throw new AppError(404, "skill_not_found", `Skill ${name} 不存在`);

  const now = new Date();
  const { dosTime, dosDate } = dosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.absolute);
    const archiveName = Buffer.from(`${name}/${file.relative}`, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    writeUInt16(local, 20, 4);
    writeUInt16(local, 0x0800, 6);
    writeUInt16(local, 0, 8);
    writeUInt16(local, dosTime, 10);
    writeUInt16(local, dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    writeUInt16(local, archiveName.length, 26);
    writeUInt16(local, 0, 28);
    localParts.push(local, archiveName, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    writeUInt16(central, 20, 4);
    writeUInt16(central, 20, 6);
    writeUInt16(central, 0x0800, 8);
    writeUInt16(central, 0, 10);
    writeUInt16(central, dosTime, 12);
    writeUInt16(central, dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    writeUInt16(central, archiveName.length, 28);
    writeUInt16(central, 0, 30);
    writeUInt16(central, 0, 32);
    writeUInt16(central, 0, 34);
    writeUInt16(central, 0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, archiveName);

    offset += local.length + archiveName.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  writeUInt16(eocd, 0, 4);
  writeUInt16(eocd, 0, 6);
  writeUInt16(eocd, files.length, 8);
  writeUInt16(eocd, files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  writeUInt16(eocd, 0, 20);

  void root;
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
