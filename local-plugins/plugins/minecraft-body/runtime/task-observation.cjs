"use strict";
const BASELINE = "1.21.11";
const OUTPUTS = new Set(["oak_planks", "stick", "crafting_table", "wooden_pickaxe"]);
function validRegion(r) {
  return !!r && typeof r.dimension === "string" && r.dimension.length < 80 && ["min", "max"].every(k => r[k] && ["x", "y", "z"].every(a => Number.isFinite(r[k][a]))) && ["x", "y", "z"].every(a => r.min[a] <= r.max[a] && r.max[a] - r.min[a] <= 64);
}
function sameRegion(a, b) { return validRegion(a) && validRegion(b) && a.dimension === b.dimension && a.allowCollect === b.allowCollect && a.allowPlace === b.allowPlace && ["min", "max"].every(k => ["x", "y", "z"].every(axis => a[k][axis] === b[k][axis])); }
function inside(p, r, dimension) { return !!p && validRegion(r) && r.dimension === dimension && ["x", "y", "z"].every(a => p[a] >= r.min[a] && p[a] <= r.max[a]); }
function recipeCatalog(bot, load = () => require("minecraft-data")) {
  const version = bot.version;
  const failed = reason => ({ supported: false, version: version || "unknown", source: "minecraft-data", reason, recipes: [] });
  if (version !== BASELINE) return failed("Only vanilla 1.21.11 recipe assumptions are supported; custom server recipes cannot be verified.");
  try {
    const data = load()(version);
    if (!data || data.version?.minecraftVersion !== version || !data.recipes || !data.items) return failed("Exact-version recipe data is unavailable.");
    const nameOf = id => data.items[id]?.name;
    const recipes = [];
    for (const [outputId, variants] of Object.entries(data.recipes)) {
      if (!OUTPUTS.has(nameOf(Number(outputId)))) continue;
      for (const [index, recipe] of variants.entries()) {
        const output = { name: nameOf(recipe.result?.id ?? Number(outputId)), count: recipe.result?.count || 1 };
        const raw = recipe.inShape ? recipe.inShape.flat() : recipe.ingredients;
        if (!output.name || !Number.isInteger(output.count) || output.count < 1 || !Array.isArray(raw)) throw new Error("Unrecognized crafting recipe data");
        const ingredients = new Map();
        for (const ingredient of raw) {
          if (ingredient == null || ingredient === -1) continue;
          const id = typeof ingredient === "number" ? ingredient : ingredient.id;
          if (id === -1) continue;
          const name = nameOf(id), count = typeof ingredient === "number" ? 1 : ingredient.count || 1;
          if (!name || !Number.isInteger(count) || count < 1) throw new Error("Unrecognized recipe ingredient");
          ingredients.set(name, (ingredients.get(name) || 0) + count);
        }
        const requiresTable = recipe.inShape ? recipe.inShape.length > 2 || recipe.inShape.some(row => row.length > 2) : raw.length > 4;
        recipes.push({ id: `${version}:${outputId}:${index}`, output, ingredients: [...ingredients].map(([name,count]) => ({name,count})), requiresTable });
      }
    }
    if ([...OUTPUTS].some(name => !recipes.some(recipe => recipe.output.name === name))) return failed("Required V1 recipe data is incomplete.");
    if (recipes.length > 4096 || JSON.stringify(recipes).length > 512000) return failed("Scoped recipe catalog exceeds safe observation limits.");
    return { supported: true, scope: [...OUTPUTS], version, source: "minecraft-data", recipes, assumption: "vanilla; custom server recipe overrides are not detectable" };
  } catch (error) { return failed(`Recipe data unavailable: ${error.message}`); }
}
module.exports = { validRegion, sameRegion, inside, recipeCatalog };
