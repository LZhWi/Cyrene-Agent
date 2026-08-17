"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCommand } = require("./commands.cjs");

test("parses movement and home commands", () => {
  assert.deepEqual(parseCommand("停止"), { type: "stop" });
  assert.deepEqual(parseCommand("设置家"), { type: "set_home" });
  assert.deepEqual(parseCommand("回家"), { type: "home" });
  assert.deepEqual(parseCommand("脱困"), { type: "escape" });
  assert.deepEqual(parseCommand("撤退"), { type: "retreat" });
  assert.deepEqual(parseCommand("跟我探索"), { type: "explore_follow" });
  assert.deepEqual(parseCommand("铺平台"), { type: "platform" });
  assert.deepEqual(parseCommand("建避难所"), { type: "shelter" });
  assert.deepEqual(parseCommand("背包"), { type: "inventory" });
  assert.deepEqual(parseCommand("看看周围"), { type: "observe", focus: "看看周围" });
  assert.deepEqual(parseCommand("观察 我在做什么"), { type: "observe", focus: "我在做什么" });
  assert.deepEqual(parseCommand("合成4个木板"), { type: "craft", item: "木板", count: 4 });
  assert.deepEqual(parseCommand("合成石镐"), { type: "craft", item: "石镐", count: 1 });
  assert.deepEqual(parseCommand("合成熔炉"), { type: "craft", item: "熔炉", count: 1 });
  assert.deepEqual(parseCommand("放工作台"), { type: "place_table" });
  assert.deepEqual(parseCommand("放熔炉"), { type: "place_furnace" });
  assert.deepEqual(parseCommand("放箱子"), { type: "place_chest" });
  assert.deepEqual(parseCommand("绑定箱子"), { type: "bind_chest" });
  assert.deepEqual(parseCommand("存入5个泥土"), { type: "deposit", item: "泥土", count: 5 });
  assert.deepEqual(parseCommand("取出木棍4个"), { type: "withdraw", item: "木棍", count: 4 });
  assert.deepEqual(parseCommand("绑定床"), { type: "bind_bed" });
  assert.deepEqual(parseCommand("放床"), { type: "place_bed" });
  assert.deepEqual(parseCommand("睡觉"), { type: "sleep" });
  assert.deepEqual(parseCommand("起床"), { type: "wake" });
  assert.deepEqual(parseCommand("吃东西"), { type: "eat" });
  assert.deepEqual(parseCommand("穿装备"), { type: "equip_armor" });
  assert.deepEqual(parseCommand("自卫"), { type: "defend" });
  assert.deepEqual(parseCommand("装备盾牌"), { type: "equip_shield" });
  assert.deepEqual(parseCommand("拿出铁剑"), { type: "hold_item", item: "铁剑" });
  assert.deepEqual(parseCommand("手持 钓鱼竿"), { type: "hold_item", item: "钓鱼竿" });
  assert.deepEqual(parseCommand("放火把"), { type: "place_torch" });
  assert.deepEqual(parseCommand("开门"), { type: "door", open: true });
  assert.deepEqual(parseCommand("关门"), { type: "door", open: false });
  assert.deepEqual(parseCommand("钓鱼"), { type: "fish" });
  assert.deepEqual(parseCommand("打水"), { type: "fill_water" });
  assert.deepEqual(parseCommand("倒水"), { type: "place_water" });
  assert.deepEqual(parseCommand("挤奶"), { type: "milk_cow" });
  assert.deepEqual(parseCommand("繁殖牛"), { type: "breed", animal: "牛" });
  assert.deepEqual(parseCommand("剪羊毛"), { type: "shear_sheep" });
  assert.deepEqual(parseCommand("找回遗物"), { type: "recover_death" });
  assert.deepEqual(parseCommand("放船"), { type: "place_boat" });
  assert.deepEqual(parseCommand("上船"), { type: "mount_boat" });
  assert.deepEqual(parseCommand("离开船"), { type: "dismount" });
  assert.deepEqual(parseCommand("下船"), { type: "dismount" });
  assert.deepEqual(parseCommand("查看交易"), { type: "list_trades" });
  assert.deepEqual(parseCommand("交易2"), { type: "trade", index: 2 });
  assert.deepEqual(parseCommand("附魔3"), { type: "enchant", choice: 3 });
  assert.deepEqual(parseCommand("重命名 幸运镐"), { type: "rename", name: "幸运镐" });
  assert.deepEqual(parseCommand("开垦耕地4块"), { type: "till", count: 4 });
  assert.deepEqual(parseCommand("种小麦4个"), { type: "plant_crop", crop: "小麦", count: 4 });
  assert.deepEqual(parseCommand("种土豆2个"), { type: "plant_crop", crop: "马铃薯", count: 2 });
  assert.deepEqual(parseCommand("收割胡萝卜3个"), { type: "harvest_crop", crop: "胡萝卜", count: 3 });
  assert.deepEqual(parseCommand("烤3个牛肉"), { type: "smelt", item: "牛肉", count: 3 });
  assert.deepEqual(parseCommand("存入手上物品"), { type: "deposit_held" });
});

test("falls back to a general observation for bare observe requests", () => {
  assert.deepEqual(parseCommand("观察"), { type: "observe", focus: "观察" });
  assert.deepEqual(parseCommand("看看"), { type: "observe", focus: "看看" });
  assert.deepEqual(parseCommand("环顾四周"), { type: "observe", focus: "环顾四周" });
  assert.deepEqual(parseCommand("observe"), { type: "observe", focus: "observe" });
});

test("parses collection commands and limits the amount", () => {
  assert.deepEqual(parseCommand("采集 3 个橡木"), { type: "collect", material: "橡木", count: 3 });
  assert.deepEqual(parseCommand("挖石头 99"), { type: "collect", material: "石头", count: 16 });
  assert.deepEqual(parseCommand("收集 木头"), { type: "collect", material: "木头", count: 1 });
  assert.deepEqual(parseCommand("采矿3个铁"), { type: "mine_ore", material: "铁", count: 3 });
  assert.deepEqual(parseCommand("安全掘进6格"), { type: "tunnel", count: 6 });
});

test("parses specific and held-item delivery", () => {
  assert.deepEqual(parseCommand("给我"), { type: "give_held" });
  assert.deepEqual(parseCommand("给我 4 个圆石"), { type: "give", material: "圆石", count: 4 });
});
