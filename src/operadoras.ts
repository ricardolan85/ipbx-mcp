import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "idoperadora.txt",
);

let cache: Map<number, string[]> | undefined;

function load(): Map<number, string[]> {
  if (cache) return cache;

  const raw = readFileSync(DATA_PATH, "utf8").replace(/^﻿/, "");
  const map = new Map<number, string[]>();

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const nome = parts[0]?.trim();
    const id = Number(parts[2]?.trim());
    if (!nome || !Number.isFinite(id)) continue;
    const list = map.get(id);
    if (list) list.push(nome);
    else map.set(id, [nome]);
  }

  cache = map;
  return map;
}

export function nomeOperadora(idoperadora: number): string | null {
  const nomes = load().get(idoperadora);
  if (!nomes || nomes.length === 0) return null;
  return nomes.join(" / ");
}
