import { Notice, TFile } from "obsidian";
import {
    getAllDailyNotes,
    getDailyNoteSettings,
} from "obsidian-daily-notes-interface";
import { FullCalendarSettings } from "./ui/settings";

/**
 * Daily note 내 지정된 헤딩 섹션에서 연속된 중복 리스트 항목을 제거합니다.
 */
export async function cleanupDuplicateDailyNoteEvents(
    app: {
        vault: {
            read: (f: TFile) => Promise<string>;
            modify: (f: TFile, content: string) => Promise<void>;
        };
    },
    settings: FullCalendarSettings
): Promise<{ filesCleaned: number; duplicatesRemoved: number }> {
    const dailynoteSources = settings.calendarSources.filter(
        (s) => s.type === "dailynote"
    );
    if (dailynoteSources.length === 0) {
        return { filesCleaned: 0, duplicatesRemoved: 0 };
    }

    const { folder } = getDailyNoteSettings();
    if (!folder) {
        new Notice("Daily note 폴더 설정을 찾을 수 없습니다.");
        return { filesCleaned: 0, duplicatesRemoved: 0 };
    }

    const notes = getAllDailyNotes();
    const files = Object.values(notes) as TFile[];
    let totalRemoved = 0;
    let filesCleaned = 0;

    for (const source of dailynoteSources) {
        if (source.type !== "dailynote") continue;
        const heading = source.heading;

        for (const file of files) {
            const folderPrefix = folder.endsWith("/") ? folder : folder + "/";
            if (!file.path.startsWith(folderPrefix) && file.path !== folder)
                continue;

            const content = await app.vault.read(file);
            const lines = content.split("\n");

            let inSection = false;
            let sectionLevel = 0;
            const sectionLines: { idx: number; text: string }[] = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
                if (headingMatch) {
                    const level = headingMatch[1].length;
                    const title = headingMatch[2].trim();
                    if (title === heading) {
                        inSection = true;
                        sectionLevel = level;
                        sectionLines.length = 0;
                    } else if (inSection && level <= sectionLevel) {
                        break;
                    }
                } else if (inSection && /^\s*-\s+/.test(line)) {
                    sectionLines.push({ idx: i, text: line });
                }
            }

            if (sectionLines.length < 2) continue;

            const seen = new Set<string>();
            const toRemove: number[] = [];
            for (const { idx, text } of sectionLines) {
                const normalized = text.trim();
                if (seen.has(normalized)) {
                    toRemove.push(idx);
                } else {
                    seen.add(normalized);
                }
            }

            if (toRemove.length > 0) {
                const newLines = lines.filter((_, i) => !toRemove.includes(i));
                await app.vault.modify(file, newLines.join("\n"));
                totalRemoved += toRemove.length;
                filesCleaned++;
            }
        }
    }

    return { filesCleaned, duplicatesRemoved: totalRemoved };
}
