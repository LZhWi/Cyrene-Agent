"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
function parseProperties(text) {
  const values = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:[#!].*)?$/.test(line)) continue;
    const match = /^([a-zA-Z0-9_.-]+)=(.*)$/.exec(line);
    if (!match || line.endsWith("\\")) throw new Error("Only canonical single-line ASCII key=value properties are accepted");
    const [, key, value] = match;
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate server property: ${key}`);
    values[key] = value;
  }
  return values;
}
function validateServerDirectory(root) {
  if (!/^eula=true\s*$/m.test(fs.readFileSync(path.join(root,"eula.txt"),"utf8"))) throw new Error("Accept Minecraft EULA yourself before this test; script never accepts it.");
  const properties = parseProperties(fs.readFileSync(path.join(root,"server.properties"),"utf8"));
  if (properties["server-ip"] !== "127.0.0.1" || properties["online-mode"] !== "false" || properties["level-name"] !== "isolated-test-world" || properties["server-port"] !== "25575") throw new Error("Only isolated-test-world on 127.0.0.1:25575 offline mode is allowed. Configure the disposable server explicitly first.");
  const world = path.join(root,"isolated-test-world");
  if (fs.existsSync(world) && fs.lstatSync(world).isSymbolicLink()) throw new Error("Test world must not be a symbolic link");
  const jar=fs.readFileSync(path.join(root,"server.jar"));
  if(createHash("sha1").update(jar).digest("hex")!=="64bb6d763bed0a9f1d632ec347938594144943ed") throw new Error("server.jar is not the pinned official Vanilla 1.21.11 artifact");
}
module.exports={parseProperties,validateServerDirectory};
