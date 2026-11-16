/**
 * MEULIFY LOCAL
 * NavigationManager.js
 * Navegación interna de la aplicación.
 */

export class NavigationManager {
    constructor(options = {}) {
        this.eventBus = options.eventBus || null;

        this.options = {
            buttonSelector: "[data-page]",
            pageSelector: "[data-page-view]",
            defaultPage: "home",
            useHistory: true,
            updateHash: true,
            ...options
        };

        this.currentPage = this.options.defaultPage;
        this.pages = new Map();
        this.initialized = false;

        this.handleDocumentClick =
            this.handleDocumentClick.bind(this);

        this.handlePopState =
            this.handlePopState.bind(this);
    }

    init() {
        if (this.initialized || typeof document === "undefined") {
            return;
        }

        document.addEventListener(
            "click",
            this.handleDocumentClick
        );

        if (this.options.useHistory && typeof window !== "undefined") {
            window.addEventListener(
                "popstate",
                this.handlePopState
            );
        }

        this.registerExistingPages();

        const hashPage = this.getPageFromHash();

        const initialPage = hashPage && this.pages.has(hashPage)
            ? hashPage
            : this.options.defaultPage;

        this.navigate(initialPage, {
            updateHistory: false,
            updateHash: false
        });

        this.initialized = true;
    }

    registerExistingPages() {
        if (typeof document === "undefined") return;

        const elements = document.querySelectorAll(
            this.options.pageSelector
        );

        elements.forEach((element) => {
            const pageName =
                element.dataset.pageView ||
                element.dataset.page ||
                element.id;

            if (pageName) {
                this.pages.set(pageName, element);
            }
        });
    }

    registerPage(name, element) {
        if (!name || !element) {
            throw new Error(
                "Se necesita el nombre y el elemento de la página."
            );
        }

        this.pages.set(name, element);

        return true;
    }

    unregisterPage(name) {
        return this.pages.delete(name);
    }

    navigate(pageName, options = {}) {
        if (typeof pageName !== "string" || !pageName.trim()) {
            return false;
        }

        const target = this.pages.get(pageName);

        if (!target) {
            console.warn(
                `[Meulify Navigation] Página no encontrada: ${pageName}`
            );

            this.emit("navigation:error", {
                page: pageName,
                reason: "PAGE_NOT_FOUND"
            });

            return false;
        }

        const previousPage = this.currentPage;

        for (const [name, element] of this.pages) {
            const active = name === pageName;

            element.hidden = !active;
            element.classList.toggle("active", active);
            element.setAttribute(
                "aria-hidden",
                String(!active)
            );
        }

        this.updateNavigationButtons(pageName);

        this.currentPage = pageName;

        if (options.updateHistory !== false) {
            this.updateHistory(pageName);
        }

        if (options.updateHash !== false) {
            this.updateHash(pageName);
        }

        this.emit("navigation:changed", {
            currentPage: pageName,
            previousPage
        });

        return true;
    }

    updateNavigationButtons(pageName) {
        if (typeof document === "undefined") return;

        const buttons = document.querySelectorAll(
            this.options.buttonSelector
        );

        buttons.forEach((button) => {
            const active = button.dataset.page === pageName;

            button.classList.toggle("active", active);

            if (active) {
                button.setAttribute("aria-current", "page");
            } else {
                button.removeAttribute("aria-current");
            }
        });
    }

    handleDocumentClick(event) {
        const button = event.target.closest(
            this.options.buttonSelector
        );

        if (!button) return;

        const pageName = button.dataset.page;

        if (!pageName) return;

        event.preventDefault();
        this.navigate(pageName);
    }

    handlePopState() {
        const pageName = this.getPageFromHash();

        if (pageName && this.pages.has(pageName)) {
            this.navigate(pageName, {
                updateHistory: false,
                updateHash: false
            });
        }
    }

    updateHistory(pageName) {
        if (
            !this.options.useHistory ||
            typeof history === "undefined"
        ) {
            return;
        }

        try {
            history.pushState(
                { page: pageName },
                "",
                this.options.updateHash
                    ? `#${encodeURIComponent(pageName)}`
                    : window.location.href
            );
        } catch (error) {
            console.error(
                "[Meulify Navigation] Error actualizando historial:",
                error
            );
        }
    }

    updateHash(pageName) {
        if (
            !this.options.updateHash ||
            typeof window === "undefined"
        ) {
            return;
        }

        const hash = `#${encodeURIComponent(pageName)}`;

        if (window.location.hash !== hash) {
            try {
                window.history.replaceState(
                    { page: pageName },
                    "",
                    hash
                );
            } catch (error) {
                console.error(
                    "[Meulify Navigation] Error actualizando URL:",
                    error
                );
            }
        }
    }

    getPageFromHash() {
        if (typeof window === "undefined") return null;

        try {
            return decodeURIComponent(
                window.location.hash.replace(/^#/, "")
            ) || null;
        } catch {
            return null;
        }
    }

    getCurrentPage() {
        return this.currentPage;
    }

    getPages() {
        return [...this.pages.keys()];
    }

    emit(eventName, data) {
        if (this.eventBus) {
            this.eventBus.emit(eventName, data);
        }
    }

    destroy() {
        if (!this.initialized || typeof document === "undefined") {
            return;
        }

        document.removeEventListener(
            "click",
            this.handleDocumentClick
        );

        if (typeof window !== "undefined") {
            window.removeEventListener(
                "popstate",
                this.handlePopState
            );
        }

        this.initialized = false;
    }
}

export default NavigationManager;