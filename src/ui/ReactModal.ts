import * as React from "react";
import * as ReactDOM from "react-dom";
import { App, Modal } from "obsidian";

type BeforeCloseFn = () => Promise<void>;
type RenderCallback = (
    close: () => void,
    registerBeforeClose: (fn: BeforeCloseFn) => void
) => Promise<ReturnType<typeof React.createElement>>;

export default class ReactModal<Props, Component> extends Modal {
    onOpenCallback: RenderCallback;
    private beforeCloseRef: { current: BeforeCloseFn | null } = {
        current: null,
    };

    constructor(app: App, onOpenCallback: RenderCallback) {
        super(app);
        this.onOpenCallback = onOpenCallback;
    }

    close(): void {
        const doActualClose = () =>
            (Modal.prototype as { close: () => void }).close.call(this);
        const fn = this.beforeCloseRef.current;
        if (fn) {
            fn()
                .then(doActualClose)
                .catch(() => doActualClose());
        } else {
            doActualClose();
        }
    }

    async onOpen() {
        const { contentEl } = this;
        const registerBeforeClose = (fn: BeforeCloseFn) => {
            this.beforeCloseRef.current = fn;
        };
        ReactDOM.render(
            await this.onOpenCallback(() => this.close(), registerBeforeClose),
            contentEl
        );
    }

    onClose() {
        const { contentEl } = this;
        ReactDOM.unmountComponentAtNode(contentEl);
    }
}
