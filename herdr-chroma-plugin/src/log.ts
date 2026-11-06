// Prints where the background daemon logs, and the end of its log.
// Usage: herdr plugin action invoke qbikez.chroma.log   (or bun src/log.ts [lines] inside herdr)
import { existsSync, readFileSync } from "node:fs";
import { stateFile } from "./instance";

const log = stateFile("daemon.log");
const lines = Number(process.argv[2] ?? 40);
console.log(log);
if (existsSync(log)) console.log(readFileSync(log, "utf8").trimEnd().split("\n").slice(-lines).join("\n"));
else console.log("(no log yet: the background daemon hasn't run)");
