"use strict";

const MAX_COUNT = 16;
const CRAFT_ALIASES = Object.freeze({
  "木板": "oak_planks",
  "木棍": "stick",
  "工作台": "crafting_table",
  "木镐": "wooden_pickaxe",
  "石镐": "stone_pickaxe",
  "木斧": "wooden_axe",
  "石斧": "stone_axe",
  "木铲": "wooden_shovel",
  "石铲": "stone_shovel",
  "木剑": "wooden_sword",
  "石剑": "stone_sword",
  "木锄": "wooden_hoe",
  "石锄": "stone_hoe",
  "铁镐": "iron_pickaxe",
  "铁斧": "iron_axe",
  "铁铲": "iron_shovel",
  "铁剑": "iron_sword",
  "铁锄": "iron_hoe",
  "钻石镐": "diamond_pickaxe",
  "钻石斧": "diamond_axe",
  "钻石铲": "diamond_shovel",
  "钻石剑": "diamond_sword",
  "钻石锄": "diamond_hoe",
  "铁头盔": "iron_helmet",
  "铁胸甲": "iron_chestplate",
  "铁护腿": "iron_leggings",
  "铁靴子": "iron_boots",
  "钻石头盔": "diamond_helmet",
  "钻石胸甲": "diamond_chestplate",
  "钻石护腿": "diamond_leggings",
  "钻石靴子": "diamond_boots",
  "箱子": "chest",
  "熔炉": "furnace",
  "火把": "torch",
  "面包": "bread",
  "盾牌": "shield",
  "弓": "bow",
  "钓鱼竿": "fishing_rod",
  "剪刀": "shears",
  "铁桶": "bucket",
  "梯子": "ladder",
  "橡木门": "oak_door",
  "橡木船": "oak_boat",
  "白床": "white_bed",
});

const MATERIAL_ALIASES = Object.freeze({
  "木头": ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"],
  "原木": ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"],
  "橡木": ["oak_log"],
  "白桦木": ["birch_log"],
  "云杉木": ["spruce_log"],
  "丛林木": ["jungle_log"],
  "金合欢木": ["acacia_log"],
  "深色橡木": ["dark_oak_log"],
  "红树木": ["mangrove_log"],
  "樱花木": ["cherry_log"],
  "石头": ["stone"],
  "圆石": ["cobblestone"],
  "泥土": ["dirt"],
  "沙子": ["sand"],
});

function boundedCount(raw) {
  const parsed = Number.parseInt(raw || "1", 10);
  return Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : 1, MAX_COUNT));
}

function materialName(raw) {
  return String(raw || "").trim().replace(/\s+/g, "");
}

function parseMaterialCommand(text, verbs, type) {
  const verb = `(?:${verbs.join("|")})`;
  let match = text.match(new RegExp(`^${verb}\\s*(\\d+)\\s*个?\\s*(.+)$`));
  if (match) return { type, material: materialName(match[2]), count: boundedCount(match[1]) };
  match = text.match(new RegExp(`^${verb}\\s*(.+?)\\s*(\\d+)\\s*个?$`));
  if (match) return { type, material: materialName(match[1]), count: boundedCount(match[2]) };
  match = text.match(new RegExp(`^${verb}\\s*(.+)$`));
  if (match) return { type, material: materialName(match[1]), count: 1 };
  return null;
}

function parseCommand(raw) {
  const text = String(raw || "").trim().toLowerCase();
  const observeFocus = text.match(/^(?:观察|看看)\s*[:：]?\s*(.+)$/);
  if (observeFocus && !/^(?:周围|四周)$/.test(observeFocus[1])) return { type: "observe", focus: observeFocus[1].trim() };
  if (/^(停止|别动|停下|stop)$/.test(text)) return { type: "stop" };
  if (/^(跟随|跟着我|follow)$/.test(text)) return { type: "follow" };
  if (/^(跟我探索|探索跟随|explore)$/.test(text)) return { type: "explore_follow" };
  if (/^(过来|来我这|come)$/.test(text)) return { type: "come" };
  if (/^(状态|status)$/.test(text)) return { type: "status" };
  // 裸“观察/看看”兜底：弱模型可能漏掉焦点词，降级为环顾四周而不是报 unknown。
  if (/^(你看到了什么|看看周围|观察周围|环顾四周|观察|看看|look around|observe)$/.test(text)) return { type: "observe", focus: text };
  if (/^(背包|物品|inventory)$/.test(text)) return { type: "inventory" };
  if (/^(设置家|设家|sethome)$/.test(text)) return { type: "set_home" };
  if (/^(回家|回家点|home)$/.test(text)) return { type: "home" };
  if (/^(捡东西|拾取|捡起来|pickup)$/.test(text)) return { type: "pickup" };
  if (/^(脱困|出来|垫脚|escape)$/.test(text)) return { type: "escape" };
  if (/^(撤退|返回安全点|retreat)$/.test(text)) return { type: "retreat" };
  if (/^(铺平台|建平台|platform)$/.test(text)) return { type: "platform" };
  if (/^(建避难所|建小屋|搭小屋|build shelter)$/.test(text)) return { type: "shelter" };
  if (/^(放工作台|摆工作台|place crafting table)$/.test(text)) return { type: "place_table" };
  if (/^(放熔炉|摆熔炉|place furnace)$/.test(text)) return { type: "place_furnace" };
  if (/^(放箱子|摆箱子|place chest)$/.test(text)) return { type: "place_chest" };
  if (/^(绑定箱子|绑定这个箱子|bind chest)$/.test(text)) return { type: "bind_chest" };
  if (/^(查看箱子|箱子内容|list chest)$/.test(text)) return { type: "list_chest" };
  if (/^(存入手上物品|存入手持物品|store held item)$/.test(text)) return { type: "deposit_held" };
  if (/^(绑定床|绑定这张床|bind bed)$/.test(text)) return { type: "bind_bed" };
  if (/^(放床|摆床|place bed)$/.test(text)) return { type: "place_bed" };
  if (/^(睡觉|上床睡觉|sleep)$/.test(text)) return { type: "sleep" };
  if (/^(起床|醒来|wake)$/.test(text)) return { type: "wake" };
  if (/^(吃东西|进食|eat)$/.test(text)) return { type: "eat" };
  if (/^(穿装备|装备护甲|equip armor)$/.test(text)) return { type: "equip_armor" };
  if (/^(自卫|防御|保护自己|defend)$/.test(text)) return { type: "defend" };
  if (/^(装备盾牌|拿盾牌|equip shield)$/.test(text)) return { type: "equip_shield" };
  const holdMatch = text.match(/^(?:拿出|手持)\s*(.+)$/);
  if (holdMatch) return { type: "hold_item", item: materialName(holdMatch[1]) };
  if (/^(放火把|照明|place torch)$/.test(text)) return { type: "place_torch" };
  if (/^(开门|打开门|open door)$/.test(text)) return { type: "door", open: true };
  if (/^(关门|关闭门|close door)$/.test(text)) return { type: "door", open: false };
  if (/^(钓鱼|开始钓鱼|fish)$/.test(text)) return { type: "fish" };
  if (/^(打水|装水|取水|fill water)$/.test(text)) return { type: "fill_water" };
  if (/^(倒水|放水|place water)$/.test(text)) return { type: "place_water" };
  if (/^(挤奶|挤牛奶|milk cow)$/.test(text)) return { type: "milk_cow" };
  let animalMatch = text.match(/^(?:繁殖|喂养)\s*(牛|羊|猪|鸡)$/);
  if (animalMatch) return { type: "breed", animal: animalMatch[1] };
  if (/^(剪羊毛|shear sheep)$/.test(text)) return { type: "shear_sheep" };
  if (/^(找回遗物|捡回遗物|回死亡点|recover items)$/.test(text)) return { type: "recover_death" };
  if (/^(放船|place boat)$/.test(text)) return { type: "place_boat" };
  if (/^(上船|坐船|mount boat)$/.test(text)) return { type: "mount_boat" };
  if (/^(下船|离开船|从船下来|dismount)$/.test(text)) return { type: "dismount" };
  if (/^(查看交易|村民交易|list trades)$/.test(text)) return { type: "list_trades" };
  let indexedMatch = text.match(/^(?:交易|购买)\s*(\d+)$/);
  if (indexedMatch) return { type: "trade", index: boundedCount(indexedMatch[1]) };
  indexedMatch = text.match(/^(?:附魔|附魔手上物品)\s*([123])$/);
  if (indexedMatch) return { type: "enchant", choice: Number(indexedMatch[1]) };
  const renameMatch = text.match(/^(?:重命名|改名)\s+(.{1,35})$/);
  if (renameMatch) return { type: "rename", name: renameMatch[1].trim() };
  let farmMatch = text.match(/^(开垦|锄地|开垦耕地)\s*(\d+)?\s*块?$/);
  if (farmMatch) return { type: "till", count: boundedCount(farmMatch[2]) };
  farmMatch = text.match(/^种\s*(小麦|胡萝卜|马铃薯|土豆|甜菜)\s*(\d+)?\s*个?$/);
  if (farmMatch) return { type: "plant_crop", crop: farmMatch[1] === "土豆" ? "马铃薯" : farmMatch[1], count: boundedCount(farmMatch[2]) };
  farmMatch = text.match(/^播种\s*(\d+)?\s*个?$/);
  if (farmMatch) return { type: "plant_crop", crop: "小麦", count: boundedCount(farmMatch[1]) };
  farmMatch = text.match(/^(?:收割|收)\s*(小麦|胡萝卜|马铃薯|土豆|甜菜)\s*(\d+)?\s*个?$/);
  if (farmMatch) return { type: "harvest_crop", crop: farmMatch[1] === "土豆" ? "马铃薯" : farmMatch[1], count: boundedCount(farmMatch[2]) };
  let smeltMatch = text.match(/^(烧炼|烧|烤)\s*(\d+)\s*个?\s*(.+)$/);
  if (smeltMatch) return { type: "smelt", item: materialName(smeltMatch[3]), count: boundedCount(smeltMatch[2]) };
  smeltMatch = text.match(/^(烧炼|烧|烤)\s*(.+?)\s*(\d+)\s*个?$/);
  if (smeltMatch) return { type: "smelt", item: materialName(smeltMatch[2]), count: boundedCount(smeltMatch[3]) };
  smeltMatch = text.match(/^(烧炼|烧|烤)\s*(.+)$/);
  if (smeltMatch) return { type: "smelt", item: materialName(smeltMatch[2]), count: 1 };
  let chestMatch = text.match(/^(存入|取出)\s*(\d+)\s*个?\s*(.+)$/);
  if (chestMatch) return { type: chestMatch[1] === "存入" ? "deposit" : "withdraw", item: materialName(chestMatch[3]), count: boundedCount(chestMatch[2]) };
  chestMatch = text.match(/^(存入|取出)\s*(.+?)\s*(\d+)\s*个?$/);
  if (chestMatch) return { type: chestMatch[1] === "存入" ? "deposit" : "withdraw", item: materialName(chestMatch[2]), count: boundedCount(chestMatch[3]) };
  let craftMatch = text.match(/^合成\s*(\d+)\s*个?\s*(.+)$/);
  if (craftMatch) return { type: "craft", item: materialName(craftMatch[2]), count: boundedCount(craftMatch[1]) };
  craftMatch = text.match(/^合成\s*(.+?)\s*(\d+)\s*个?$/);
  if (craftMatch) return { type: "craft", item: materialName(craftMatch[1]), count: boundedCount(craftMatch[2]) };
  craftMatch = text.match(/^合成\s*(.+)$/);
  if (craftMatch) return { type: "craft", item: materialName(craftMatch[1]), count: 1 };
  if (/^(给我|交给我|give)$/.test(text)) return { type: "give_held" };
  const mine = parseMaterialCommand(text, ["采矿", "挖矿"], "mine_ore");
  if (mine) return mine;
  const tunnel = text.match(/^(?:安全掘进|水平掘进|挖巷道)\s*(\d+)?\s*格?$/);
  if (tunnel) return { type: "tunnel", count: boundedCount(tunnel[1]) };
  return parseMaterialCommand(text, ["采集", "收集", "挖"], "collect")
    || parseMaterialCommand(text, ["给我", "交给我", "give"], "give")
    || { type: "unknown" };
}

module.exports = { CRAFT_ALIASES, MATERIAL_ALIASES, MAX_COUNT, parseCommand };
