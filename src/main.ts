import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import {
    CalendarView,
    FULL_CALENDAR_SIDEBAR_VIEW_TYPE,
    FULL_CALENDAR_VIEW_TYPE,
} from "./ui/view";
import { renderCalendar } from "./ui/calendar";
import { toEventInput } from "./ui/interop";
import {
    DEFAULT_SETTINGS,
    FullCalendarSettings,
    FullCalendarSettingTab,
} from "./ui/settings";
import { PLUGIN_SLUG } from "./types";
import EventCache from "./core/EventCache";
import { ObsidianIO } from "./ObsidianAdapter";
import { launchCreateModal } from "./ui/event_modal";
import FullNoteCalendar from "./calendars/FullNoteCalendar";
import DailyNoteCalendar from "./calendars/DailyNoteCalendar";
import ICSCalendar from "./calendars/ICSCalendar";
import CalDAVCalendar from "./calendars/CalDAVCalendar";
import { GoogleAuthService, GoogleTokens } from "./auth/GoogleAuth";
import GoogleCalendar from "./calendars/GoogleCalendar";
import { cleanupDuplicateDailyNoteEvents } from "./cleanupDuplicateDailyEvents";

const GOOGLE_TOKENS_SECRET_KEY = "full-calendar-google-oauth-tokens";

export default class FullCalendarPlugin extends Plugin {
    settings: FullCalendarSettings = DEFAULT_SETTINGS;
    googleAuth: GoogleAuthService | null = null;
    cache: EventCache = new EventCache({
        local: (info) =>
            info.type === "local"
                ? new FullNoteCalendar(
                      new ObsidianIO(this.app),
                      info.color,
                      info.directory
                  )
                : null,
        dailynote: (info) =>
            info.type === "dailynote"
                ? new DailyNoteCalendar(
                      new ObsidianIO(this.app),
                      info.color,
                      info.heading
                  )
                : null,
        ical: (info) =>
            info.type === "ical" ? new ICSCalendar(info.color, info.url) : null,
        caldav: (info) =>
            info.type === "caldav"
                ? new CalDAVCalendar(
                      info.color,
                      info.name,
                      {
                          type: "basic",
                          username: info.username,
                          password: info.password,
                      },
                      info.url,
                      info.homeUrl
                  )
                : null,
        gcal: (info) =>
            info.type === "gcal" && this.googleAuth
                ? new GoogleCalendar(
                      info.color,
                      info.name,
                      info.calendarId,
                      this.googleAuth
                  )
                : null,
        FOR_TEST_ONLY: () => null,
    });

    renderCalendar = renderCalendar;
    processFrontmatter = toEventInput;

    async activateView() {
        const leaves = this.app.workspace
            .getLeavesOfType(FULL_CALENDAR_VIEW_TYPE)
            .filter((l) => (l.view as CalendarView).inSidebar === false);
        if (leaves.length === 0) {
            const leaf = this.app.workspace.getLeaf("tab");
            await leaf.setViewState({
                type: FULL_CALENDAR_VIEW_TYPE,
                active: true,
            });
        } else {
            await Promise.all(
                leaves.map((l) => (l.view as CalendarView).onOpen())
            );
        }
    }
    private async loadGoogleTokensFromStorage(): Promise<GoogleTokens | null> {
        const storage = (
            this.app as {
                secretStorage?: { getSecret?: (k: string) => string | null };
            }
        ).secretStorage;
        if (!storage?.getSecret) return null;
        try {
            const raw = storage.getSecret(GOOGLE_TOKENS_SECRET_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as GoogleTokens;
            return parsed?.refreshToken ? parsed : null;
        } catch {
            return null;
        }
    }

    private async saveGoogleTokensToStorage(
        tokens: GoogleTokens
    ): Promise<boolean> {
        const storage = (
            this.app as {
                secretStorage?: { setSecret?: (k: string, v: string) => void };
            }
        ).secretStorage;
        if (!storage?.setSecret) return false;
        try {
            storage.setSecret(GOOGLE_TOKENS_SECRET_KEY, JSON.stringify(tokens));
            return true;
        } catch {
            return false;
        }
    }

    private deleteGoogleTokensFromStorage(): void {
        const storage = (
            this.app as {
                secretStorage?: { setSecret?: (k: string, v: string) => void };
            }
        ).secretStorage;
        if (!storage?.setSecret) return;
        try {
            storage.setSecret(GOOGLE_TOKENS_SECRET_KEY, "");
        } catch {
            /* ignore */
        }
    }

    private getSettingsForSave(): FullCalendarSettings {
        return {
            ...this.settings,
            googleRefreshToken: "",
            googleAccessToken: "",
            googleTokenExpiry: 0,
        };
    }

    async initGoogleAuth() {
        let tokens: GoogleTokens | null = null;

        const storage = (this.app as { secretStorage?: unknown }).secretStorage;
        if (storage) {
            tokens = await this.loadGoogleTokensFromStorage();
        }
        if (!tokens && this.settings.googleRefreshToken) {
            tokens = {
                accessToken: this.settings.googleAccessToken || "",
                refreshToken: this.settings.googleRefreshToken,
                expiresAt: this.settings.googleTokenExpiry || 0,
            };
            if (storage) {
                await this.saveGoogleTokensToStorage(tokens);
                this.settings.googleRefreshToken = "";
                this.settings.googleAccessToken = "";
                this.settings.googleTokenExpiry = 0;
                await this.saveData(this.getSettingsForSave());
            }
        }

        this.googleAuth = new GoogleAuthService(
            {
                clientId: this.settings.googleClientId,
                clientSecret: this.settings.googleClientSecret,
            },
            tokens,
            async (newTokens) => {
                if (newTokens.refreshToken || newTokens.accessToken) {
                    const ok = await this.saveGoogleTokensToStorage(newTokens);
                    if (ok) {
                        await this.saveData(this.getSettingsForSave());
                    } else {
                        this.settings.googleAccessToken = newTokens.accessToken;
                        this.settings.googleRefreshToken =
                            newTokens.refreshToken;
                        this.settings.googleTokenExpiry = newTokens.expiresAt;
                        await Plugin.prototype.saveData.call(
                            this,
                            this.settings
                        );
                    }
                } else {
                    this.deleteGoogleTokensFromStorage();
                    await this.saveData(this.getSettingsForSave());
                }
            }
        );
    }

    async onload() {
        await this.loadSettings();
        await this.initGoogleAuth();

        this.cache.reset(this.settings.calendarSources);

        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                this.cache.fileUpdated(file);
            })
        );

        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof TFile) {
                    console.debug("FILE RENAMED", file.path);
                    this.cache.deleteEventsAtPath(oldPath);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (file instanceof TFile) {
                    console.debug("FILE DELETED", file.path);
                    this.cache.deleteEventsAtPath(file.path);
                }
            })
        );

        // @ts-ignore
        window.cache = this.cache;

        this.registerView(
            FULL_CALENDAR_VIEW_TYPE,
            (leaf) => new CalendarView(leaf, this, false)
        );

        this.registerView(
            FULL_CALENDAR_SIDEBAR_VIEW_TYPE,
            (leaf) => new CalendarView(leaf, this, true)
        );

        this.addRibbonIcon(
            "calendar-glyph",
            "Open Full Calendar",
            async (_: MouseEvent) => {
                await this.activateView();
            }
        );

        this.addSettingTab(new FullCalendarSettingTab(this.app, this));

        this.addCommand({
            id: "full-calendar-new-event",
            name: "New Event",
            callback: () => {
                launchCreateModal(this, {});
            },
        });

        this.addCommand({
            id: "full-calendar-reset",
            name: "Reset Event Cache",
            callback: () => {
                this.cache.reset(this.settings.calendarSources);
                this.app.workspace.detachLeavesOfType(FULL_CALENDAR_VIEW_TYPE);
                this.app.workspace.detachLeavesOfType(
                    FULL_CALENDAR_SIDEBAR_VIEW_TYPE
                );
                new Notice("Full Calendar has been reset.");
            },
        });

        this.addCommand({
            id: "full-calendar-cleanup-duplicates",
            name: "Clean duplicate daily note events",
            callback: async () => {
                try {
                    const { filesCleaned, duplicatesRemoved } =
                        await cleanupDuplicateDailyNoteEvents(
                            this.app,
                            this.settings
                        );
                    this.cache.reset(this.settings.calendarSources);
                    await this.cache.populate();
                    this.cache.resync();
                    new Notice(
                        `중복 일정 정리 완료: ${filesCleaned}개 파일에서 ${duplicatesRemoved}개 제거됨.`
                    );
                } catch (e) {
                    console.error(e);
                    new Notice(
                        e instanceof Error
                            ? e.message
                            : "중복 정리 중 오류 발생"
                    );
                }
            },
        });

        this.addCommand({
            id: "full-calendar-revalidate",
            name: "Revalidate remote calendars",
            callback: () => {
                this.cache.revalidateRemoteCalendars(true);
            },
        });

        this.addCommand({
            id: "full-calendar-open",
            name: "Open Calendar",
            callback: () => {
                this.activateView();
            },
        });

        this.addCommand({
            id: "full-calendar-open-sidebar",
            name: "Open in sidebar",
            callback: () => {
                if (
                    this.app.workspace.getLeavesOfType(
                        FULL_CALENDAR_SIDEBAR_VIEW_TYPE
                    ).length
                ) {
                    return;
                }
                this.app.workspace.getRightLeaf(false).setViewState({
                    type: FULL_CALENDAR_SIDEBAR_VIEW_TYPE,
                });
            },
        });

        (this.app.workspace as any).registerHoverLinkSource(PLUGIN_SLUG, {
            display: "Full Calendar",
            defaultMod: true,
        });
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(FULL_CALENDAR_VIEW_TYPE);
        this.app.workspace.detachLeavesOfType(FULL_CALENDAR_SIDEBAR_VIEW_TYPE);
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveData(data?: unknown): Promise<void> {
        const toSave =
            data && typeof data === "object" && "calendarSources" in data
                ? this.getSettingsForSave()
                : data ?? this.getSettingsForSave();
        return super.saveData(toSave);
    }

    async saveSettings() {
        new Notice("Resetting the event cache with new settings...");
        await this.saveData(this.settings);
        this.cache.reset(this.settings.calendarSources);
        await this.cache.populate();
        this.cache.resync();
    }
}
