import { Notice } from "obsidian";
import * as React from "react";
import { EditableCalendar } from "src/calendars/EditableCalendar";
import GoogleCalendar from "src/calendars/GoogleCalendar";
import FullCalendarPlugin from "src/main";
import { OFCEvent } from "src/types";
import { openFileForEvent } from "./actions";
import { EditEvent } from "./components/EditEvent";
import ReactModal from "./ReactModal";

export function launchCreateModal(
    plugin: FullCalendarPlugin,
    partialEvent: Partial<OFCEvent>
) {
    const calendars = [...plugin.cache.calendars.entries()]
        .filter(
            ([_, cal]) =>
                cal instanceof EditableCalendar || cal instanceof GoogleCalendar
        )
        .map(([id, cal]) => {
            return {
                id,
                type: cal.type,
                name: cal.name,
            };
        });
    new ReactModal(plugin.app, async (closeModal, registerBeforeClose) =>
        React.createElement(EditEvent, {
            initialEvent: partialEvent,
            calendars,
            defaultCalendarIndex: 0,
            closeModal,
            registerBeforeClose,
            isCreate: true,
            submit: async (data, calendarIndex, options) => {
                const calendarId = calendars[calendarIndex].id;
                try {
                    await plugin.cache.addEvent(calendarId, data);
                    options?.markCreated?.();
                } catch (e) {
                    if (e instanceof Error) {
                        new Notice("Error when creating event: " + e.message);
                        console.error(e);
                    }
                }
                closeModal();
            },
        })
    ).open();
}

export function launchEditModal(plugin: FullCalendarPlugin, eventId: string) {
    const eventToEdit = plugin.cache.getEventById(eventId);
    if (!eventToEdit) {
        throw new Error("Cannot edit event that doesn't exist.");
    }
    const calId = plugin.cache.getWritableCalendarForEvent(eventId).id;

    const calendars = [...plugin.cache.calendars.entries()]
        .filter(
            ([_, cal]) =>
                cal instanceof EditableCalendar || cal instanceof GoogleCalendar
        )
        .map(([id, cal]) => {
            return {
                id,
                type: cal.type,
                name: cal.name,
            };
        });

    const calIdx = calendars.findIndex(({ id }) => id === calId);
    const isGoogleCalEvent =
        plugin.cache.getCalendarById(calId) instanceof GoogleCalendar;

    new ReactModal(plugin.app, async (closeModal, registerBeforeClose) =>
        React.createElement(EditEvent, {
            initialEvent: eventToEdit,
            calendars,
            defaultCalendarIndex: calIdx,
            closeModal,
            registerBeforeClose,
            isCreate: false,
            submit: async (data, calendarIndex, _options) => {
                try {
                    if (calendarIndex !== calIdx) {
                        await plugin.cache.moveEventToCalendar(
                            eventId,
                            calendars[calendarIndex].id
                        );
                    }
                    await plugin.cache.updateEventWithId(eventId, data);
                } catch (e) {
                    if (e instanceof Error) {
                        const msg = e.message;
                        const isStale =
                            msg.includes("not present in event store") ||
                            msg.includes("not registered");
                        if (isStale) {
                            new Notice(
                                "이벤트가 캐시에서 제거되었습니다. 캘린더를 새로고침해주세요."
                            );
                        } else {
                            new Notice("Error when updating event: " + msg);
                        }
                        console.error(e);
                    }
                }
            },
            // Google Calendar events don't have a note file in the Vault
            open: isGoogleCalEvent
                ? undefined
                : async () => {
                      openFileForEvent(plugin.cache, plugin.app, eventId);
                  },
            deleteEvent: async () => {
                try {
                    await plugin.cache.deleteEvent(eventId);
                    closeModal();
                } catch (e) {
                    if (e instanceof Error) {
                        new Notice("Error when deleting event: " + e.message);
                        console.error(e);
                    }
                }
            },
        })
    ).open();
}
