#!/usr/bin/env node
/**
 * 플러그인 빌드 후 Obsidian 볼트에 복사
 * - 기본: Obsidian obsidian.json에서 열린 볼트 목록을 자동 탐지
 * - OBSIDIAN_VAULT_PATH 환경변수로 단일 경로 지정 가능 (세미콜론으로 복수 경로)
 */
import { copyFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = "obsidian-full-calendar";
// Obsidian은 styles.css를 로드함 (esbuild는 main.css 출력)
const FILES = [
  ["main.js", "main.js"],
  ["main.css", "styles.css"],
  ["manifest.json", "manifest.json"],
];

function getVaultPaths() {
  // 환경변수로 지정된 경로가 있으면 우선 사용
  const envPath = process.env.OBSIDIAN_VAULT_PATH;
  if (envPath) {
    return envPath.split(";").map((p) => p.trim()).filter(Boolean);
  }

  // Windows: AppData\Roaming\obsidian\obsidian.json
  const obsidianConfigPath = join(
    process.env.APPDATA || "",
    "obsidian",
    "obsidian.json"
  );
  if (existsSync(obsidianConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(obsidianConfigPath, "utf-8"));
      const vaults = config.vaults || {};
      return Object.values(vaults).map((v) => v.path).filter(Boolean);
    } catch (e) {
      console.warn("obsidian.json 파싱 실패:", e.message);
    }
  }
  return [];
}

const vaultPaths = getVaultPaths();
if (vaultPaths.length === 0) {
  console.log(
    "볼트를 찾을 수 없습니다. OBSIDIAN_VAULT_PATH 환경변수로 경로를 지정하세요."
  );
  process.exit(1);
}

for (const vaultPath of vaultPaths) {
  const destDir = join(vaultPath, ".obsidian", "plugins", PLUGIN_ID);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }
  for (const [srcName, destName] of FILES) {
    const src = join(__dirname, srcName);
    if (existsSync(src)) {
      copyFileSync(src, join(destDir, destName));
      console.log(`✓ ${srcName} → ${destName} (${vaultPath})`);
    }
  }
}
console.log("\n배포 완료! Obsidian에서 Ctrl+P → 'Reload app' 검색 후 실행하세요. (종료할 필요 없음)");
