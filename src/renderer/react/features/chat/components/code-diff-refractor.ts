import refractor from "refractor/core";
import bash from "refractor/lang/bash";
import c from "refractor/lang/c";
import cpp from "refractor/lang/cpp";
import csharp from "refractor/lang/csharp";
import go from "refractor/lang/go";
import java from "refractor/lang/java";
import json from "refractor/lang/json";
import markdown from "refractor/lang/markdown";
import php from "refractor/lang/php";
import powershell from "refractor/lang/powershell";
import python from "refractor/lang/python";
import ruby from "refractor/lang/ruby";
import rust from "refractor/lang/rust";
import scss from "refractor/lang/scss";
import sql from "refractor/lang/sql";
import tsx from "refractor/lang/tsx";
import typescript from "refractor/lang/typescript";
import yaml from "refractor/lang/yaml";

// `refractor/core` already includes markup, CSS and JavaScript. Register only
// languages Cyrene's Code workspace commonly needs instead of bundling all of Prism.
[
  bash, c, cpp, csharp, go, java, json, markdown, php, powershell, python,
  ruby, rust, scss, sql, tsx, typescript, yaml,
].forEach((language) => refractor.register(language));

export { refractor };
