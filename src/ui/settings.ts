import FullCalendarPlugin from "../main";
import {
    App,
    DropdownComponent,
    Notice,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
} from "obsidian";
import { makeDefaultPartialCalendarSource, CalendarInfo } from "../types";
import { toHexForColorInput } from "../colorUtils";
import { CalendarSettings } from "./components/CalendarSetting";
import { AddCalendarSource } from "./components/AddCalendarSource";
import * as ReactDOM from "react-dom";
import { createElement } from "react";
import { getDailyNoteSettings } from "obsidian-daily-notes-interface";
import ReactModal from "./ReactModal";
import { importCalendars } from "src/calendars/parsing/caldav/import";
import { GoogleAuthService } from "../auth/GoogleAuth";

export type GcalEventVisualStyle =
    | "icon"
    | "border"
    | "badge"
    | "pattern"
    | "none";

export interface FullCalendarSettings {
    calendarSources: CalendarInfo[];
    defaultCalendar: number;
    firstDay: number;
    initialView: {
        desktop: string;
        mobile: string;
    };
    timeFormat24h: boolean;
    clickToCreateEventFromMonthView: boolean;
    slotMinTime: string;
    slotMaxTime: string;
    googleClientId: string;
    googleClientSecret: string;
    googleRefreshToken: string;
    googleAccessToken: string;
    googleTokenExpiry: number;
    gcalEventVisualStyle: GcalEventVisualStyle;
    gcalCalendarColorSync: boolean;
    gcalEventColorSync: boolean;
    gcalIconColor: string;
    gcalBorderColor: string;
    gcalPatternColor: string;
}

export const DEFAULT_SETTINGS: FullCalendarSettings = {
    calendarSources: [],
    defaultCalendar: 0,
    firstDay: 0,
    initialView: {
        desktop: "timeGridWeek",
        mobile: "timeGrid3Days",
    },
    timeFormat24h: false,
    clickToCreateEventFromMonthView: true,
    slotMinTime: "00:00:00",
    slotMaxTime: "24:00:00",
    googleClientId: "",
    googleClientSecret: "",
    googleRefreshToken: "",
    googleAccessToken: "",
    googleTokenExpiry: 0,
    gcalEventVisualStyle: "icon",
    gcalCalendarColorSync: true,
    gcalEventColorSync: true,
    gcalIconColor: "#4285f4",
    gcalBorderColor: "#4285f4",
    gcalPatternColor: "#000000",
};

const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

const TIME_OPTIONS: Record<string, string> = {};
for (let h = 0; h <= 24; h++) {
    const val = `${h.toString().padStart(2, "0")}:00:00`;
    const label =
        h === 24 ? "24:00 (Midnight)" : `${h.toString().padStart(2, "0")}:00`;
    TIME_OPTIONS[val] = label;
}

const INITIAL_VIEW_OPTIONS = {
    DESKTOP: {
        timeGridDay: "Day",
        timeGridWeek: "Week",
        dayGridMonth: "Month",
        listWeek: "List",
    },
    MOBILE: {
        timeGrid3Days: "3 Days",
        timeGridDay: "Day",
        listWeek: "List",
    },
};

export function addCalendarButton(
    app: App,
    plugin: FullCalendarPlugin,
    containerEl: HTMLElement,
    submitCallback: (setting: CalendarInfo) => void,
    listUsedDirectories?: () => string[]
) {
    let dropdown: DropdownComponent;
    const directories = app.vault
        .getAllLoadedFiles()
        .filter((f) => f instanceof TFolder)
        .map((f) => f.path);

    return new Setting(containerEl)
        .setName("Calendars")
        .setDesc("Add calendar")
        .addDropdown(
            (d) =>
                (dropdown = d.addOptions({
                    local: "Full note",
                    dailynote: "Daily Note",
                    icloud: "iCloud",
                    caldav: "CalDAV",
                    ical: "Remote (.ics format)",
                    gcal: "Google Calendar",
                }))
        )
        .addExtraButton((button) => {
            button.setTooltip("Add Calendar");
            button.setIcon("plus-with-circle");
            button.onClick(() => {
                let modal = new ReactModal(app, async () => {
                    await plugin.loadSettings();
                    const usedDirectories = (
                        listUsedDirectories
                            ? listUsedDirectories
                            : () =>
                                  plugin.settings.calendarSources
                                      .map(
                                          (s) =>
                                              s.type === "local" && s.directory
                                      )
                                      .filter((s): s is string => !!s)
                    )();
                    let headings: string[] = [];
                    let { template } = getDailyNoteSettings();

                    if (template) {
                        if (!template.endsWith(".md")) {
                            template += ".md";
                        }
                        const file = app.vault.getAbstractFileByPath(template);
                        if (file instanceof TFile) {
                            headings =
                                app.metadataCache
                                    .getFileCache(file)
                                    ?.headings?.map((h) => h.heading) || [];
                        }
                    }

                    // Fetch Google Calendar list if the selected type is gcal
                    let googleCalendars: Array<{
                        id: string;
                        summary: string;
                        primary: boolean;
                    }> = [];
                    const selectedType = dropdown.getValue();
                    if (
                        selectedType === "gcal" &&
                        plugin.googleAuth?.isAuthenticated
                    ) {
                        try {
                            googleCalendars =
                                await plugin.googleAuth.listCalendars();
                        } catch (e) {
                            console.error(
                                "Failed to fetch Google Calendar list:",
                                e
                            );
                            new Notice(
                                "Failed to fetch Google Calendar list. Please check your authorization."
                            );
                        }
                    }

                    return createElement(AddCalendarSource, {
                        source: makeDefaultPartialCalendarSource(
                            dropdown.getValue() as CalendarInfo["type"]
                        ),
                        directories: directories.filter(
                            (dir) => usedDirectories.indexOf(dir) === -1
                        ),
                        headings,
                        googleCalendars,
                        submit: async (source: CalendarInfo) => {
                            if (source.type === "caldav") {
                                try {
                                    let sources = await importCalendars(
                                        {
                                            type: "basic",
                                            username: source.username,
                                            password: source.password,
                                        },
                                        source.url
                                    );
                                    sources.forEach((source) =>
                                        submitCallback(source)
                                    );
                                } catch (e) {
                                    if (e instanceof Error) {
                                        new Notice(e.message);
                                    }
                                }
                            } else {
                                submitCallback(source);
                            }
                            modal.close();
                        },
                    });
                });
                modal.open();
            });
        });
}

export class FullCalendarSettingTab extends PluginSettingTab {
    plugin: FullCalendarPlugin;

    constructor(app: App, plugin: FullCalendarPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "Calendar Preferences" });
        new Setting(containerEl)
            .setName("Desktop Initial View")
            .setDesc("Choose the initial view range on desktop devices.")
            .addDropdown((dropdown) => {
                Object.entries(INITIAL_VIEW_OPTIONS.DESKTOP).forEach(
                    ([value, display]) => {
                        dropdown.addOption(value, display);
                    }
                );
                dropdown.setValue(this.plugin.settings.initialView.desktop);
                dropdown.onChange(async (initialView) => {
                    this.plugin.settings.initialView.desktop = initialView;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Mobile Initial View")
            .setDesc("Choose the initial view range on mobile devices.")
            .addDropdown((dropdown) => {
                Object.entries(INITIAL_VIEW_OPTIONS.MOBILE).forEach(
                    ([value, display]) => {
                        dropdown.addOption(value, display);
                    }
                );
                dropdown.setValue(this.plugin.settings.initialView.mobile);
                dropdown.onChange(async (initialView) => {
                    this.plugin.settings.initialView.mobile = initialView;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Starting Day of the Week")
            .setDesc("Choose what day of the week to start.")
            .addDropdown((dropdown) => {
                WEEKDAYS.forEach((day, code) => {
                    dropdown.addOption(code.toString(), day);
                });
                dropdown.setValue(this.plugin.settings.firstDay.toString());
                dropdown.onChange(async (codeAsString) => {
                    this.plugin.settings.firstDay = Number(codeAsString);
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("24-hour format")
            .setDesc("Display the time in a 24-hour format.")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.timeFormat24h);
                toggle.onChange(async (val) => {
                    this.plugin.settings.timeFormat24h = val;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Click on a day in month view to create event")
            .setDesc("Switch off to open day view on click instead.")
            .addToggle((toggle) => {
                toggle.setValue(
                    this.plugin.settings.clickToCreateEventFromMonthView
                );
                toggle.onChange(async (val) => {
                    this.plugin.settings.clickToCreateEventFromMonthView = val;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Visible time range start")
            .setDesc(
                "Hide time slots before this hour (e.g. hide sleeping hours)."
            )
            .addDropdown((dropdown) => {
                Object.entries(TIME_OPTIONS).forEach(([value, display]) => {
                    dropdown.addOption(value, display);
                });
                dropdown.setValue(this.plugin.settings.slotMinTime);
                dropdown.onChange(async (val) => {
                    this.plugin.settings.slotMinTime = val;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Visible time range end")
            .setDesc(
                "Hide time slots after this hour (e.g. hide sleeping hours)."
            )
            .addDropdown((dropdown) => {
                Object.entries(TIME_OPTIONS).forEach(([value, display]) => {
                    dropdown.addOption(value, display);
                });
                dropdown.setValue(this.plugin.settings.slotMaxTime);
                dropdown.onChange(async (val) => {
                    this.plugin.settings.slotMaxTime = val;
                    await this.plugin.saveSettings();
                });
            });

        containerEl.createEl("h2", { text: "Google Calendar Integration" });
        containerEl.createEl("p", {
            text: "To use Google Calendar, create OAuth 2.0 credentials in the Google Cloud Console. Enable the Google Calendar API, create a Desktop app OAuth client, and enter the Client ID and Secret below.",
            cls: "setting-item-description",
        });

        new Setting(containerEl)
            .setName("Google Client ID")
            .setDesc("OAuth 2.0 Client ID from Google Cloud Console.")
            .addText((text) => {
                text.setPlaceholder("your-client-id.apps.googleusercontent.com")
                    .setValue(this.plugin.settings.googleClientId)
                    .onChange(async (val) => {
                        this.plugin.settings.googleClientId = val;
                        await this.plugin.saveData(this.plugin.settings);
                    });
                text.inputEl.style.width = "300px";
            });

        new Setting(containerEl)
            .setName("Google Client Secret")
            .setDesc("OAuth 2.0 Client Secret from Google Cloud Console.")
            .addText((text) => {
                text.setPlaceholder("GOCSPX-...")
                    .setValue(this.plugin.settings.googleClientSecret)
                    .onChange(async (val) => {
                        this.plugin.settings.googleClientSecret = val;
                        await this.plugin.saveData(this.plugin.settings);
                    });
                text.inputEl.style.width = "300px";
                text.inputEl.type = "password";
            });

        const authStatusSetting = new Setting(containerEl)
            .setName("Authorization Status")
            .setDesc(
                this.plugin.googleAuth?.isAuthenticated
                    ? "Authorized. You can add Google Calendars below."
                    : "Not authorized. Click the button to authorize."
            );

        if (this.plugin.googleAuth?.isAuthenticated) {
            authStatusSetting.addButton((button) => {
                button
                    .setButtonText("Revoke Authorization")
                    .setWarning()
                    .onClick(async () => {
                        try {
                            await this.plugin.googleAuth?.revokeAuth();
                            this.display();
                        } catch (e) {
                            if (e instanceof Error) {
                                new Notice(e.message);
                            }
                        }
                    });
            });
        } else {
            authStatusSetting.addButton((button) => {
                button
                    .setButtonText("Authorize Google Calendar")
                    .setCta()
                    .onClick(async () => {
                        try {
                            this.plugin.initGoogleAuth();
                            await this.plugin.googleAuth?.startAuthFlow();
                            this.display();
                        } catch (e) {
                            if (e instanceof Error) {
                                new Notice(e.message);
                            }
                        }
                    });
            });
        }

        const GCAL_VISUAL_STYLE_OPTIONS: Record<GcalEventVisualStyle, string> =
            {
                icon: "아이콘/도트",
                border: "테두리",
                badge: "배지",
                pattern: "배경 패턴",
                none: "없음",
            };

        new Setting(containerEl)
            .setName("구글 캘린더 이벤트 시각적 구분")
            .setDesc(
                "캘린더에서 구글 캘린더 이벤트를 구분하는 방식을 선택합니다."
            )
            .addDropdown((dropdown) => {
                (
                    Object.entries(GCAL_VISUAL_STYLE_OPTIONS) as [
                        GcalEventVisualStyle,
                        string
                    ][]
                ).forEach(([value, label]) => {
                    dropdown.addOption(value, label);
                });
                dropdown.setValue(this.plugin.settings.gcalEventVisualStyle);
                dropdown.onChange(async (val) => {
                    this.plugin.settings.gcalEventVisualStyle =
                        val as GcalEventVisualStyle;
                    updateColorPickerVisibility(
                        this.plugin.settings.gcalEventVisualStyle
                    );
                    await this.plugin.saveSettings();
                });
            });

        const updateColorPickerVisibility = (style: GcalEventVisualStyle) => {
            iconColorSetting.settingEl.style.display =
                style === "icon" ? "" : "none";
            borderColorSetting.settingEl.style.display =
                style === "border" ? "" : "none";
            patternColorSetting.settingEl.style.display =
                style === "pattern" ? "" : "none";
        };

        const iconColorSetting = new Setting(containerEl)
            .setName("아이콘/도트 색상")
            .setDesc("아이콘/도트 형식 선택 시 사용할 색상입니다.")
            .addText((text) => {
                const input = text.inputEl;
                input.type = "color";
                input.style.minWidth = "3rem";
                input.style.maxWidth = "25%";
                input.value = toHexForColorInput(
                    this.plugin.settings.gcalIconColor
                );
                input.onchange = async () => {
                    this.plugin.settings.gcalIconColor = input.value;
                    await this.plugin.saveSettings();
                };
            });

        const borderColorSetting = new Setting(containerEl)
            .setName("테두리 색상")
            .setDesc("테두리 형식 선택 시 사용할 색상입니다.")
            .addText((text) => {
                const input = text.inputEl;
                input.type = "color";
                input.style.minWidth = "3rem";
                input.style.maxWidth = "25%";
                input.value = toHexForColorInput(
                    this.plugin.settings.gcalBorderColor
                );
                input.onchange = async () => {
                    this.plugin.settings.gcalBorderColor = input.value;
                    await this.plugin.saveSettings();
                };
            });

        const patternColorSetting = new Setting(containerEl)
            .setName("배경 패턴 색상")
            .setDesc("배경 패턴 형식 선택 시 사용할 색상입니다.")
            .addText((text) => {
                const input = text.inputEl;
                input.type = "color";
                input.style.minWidth = "3rem";
                input.style.maxWidth = "25%";
                input.value = toHexForColorInput(
                    this.plugin.settings.gcalPatternColor
                );
                input.onchange = async () => {
                    this.plugin.settings.gcalPatternColor = input.value;
                    await this.plugin.saveSettings();
                };
            });

        updateColorPickerVisibility(this.plugin.settings.gcalEventVisualStyle);

        new Setting(containerEl)
            .setName("캘린더 색상 구글 동기화")
            .setDesc(
                "설정에서 변경한 캘린더 색상을 구글 캘린더에 동기화합니다 (가장 비슷한 색으로)."
            )
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.gcalCalendarColorSync);
                toggle.onChange(async (val) => {
                    this.plugin.settings.gcalCalendarColorSync = val;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("일정 색상 구글 동기화")
            .setDesc(
                "일정별 색상을 구글 캘린더에 반영합니다 (가장 비슷한 색으로)."
            )
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.gcalEventColorSync);
                toggle.onChange(async (val) => {
                    this.plugin.settings.gcalEventColorSync = val;
                    await this.plugin.saveSettings();
                });
            });

        containerEl.createEl("h2", { text: "Manage Calendars" });
        addCalendarButton(
            this.app,
            this.plugin,
            containerEl,
            async (source: CalendarInfo) => {
                sourceList.addSource(source);
            },
            () =>
                sourceList.state.sources
                    .map((s) => s.type === "local" && s.directory)
                    .filter((s): s is string => !!s)
        );

        const sourcesDiv = containerEl.createDiv();
        sourcesDiv.style.display = "block";
        let sourceList = ReactDOM.render(
            createElement(CalendarSettings, {
                sources: this.plugin.settings.calendarSources,
                submit: async (settings: CalendarInfo[]) => {
                    this.plugin.settings.calendarSources = settings;
                    await this.plugin.saveSettings();
                    this.plugin.cache.reset(
                        this.plugin.settings.calendarSources
                    );
                    await this.plugin.cache.populate();
                    this.plugin.cache.resync();
                },
            }),
            sourcesDiv
        );
    }
}
