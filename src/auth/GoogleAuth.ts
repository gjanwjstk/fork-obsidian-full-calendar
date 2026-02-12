import { requestUrl, Notice } from "obsidian";
import * as http from "http";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_SCOPE =
    "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events";

export interface GoogleTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export interface GoogleAuthConfig {
    clientId: string;
    clientSecret: string;
}

/**
 * Manages Google OAuth 2.0 authentication flow using loopback redirect.
 * Uses Node.js http module (available in Electron/Obsidian) to create
 * a temporary localhost server for receiving the authorization code.
 */
export class GoogleAuthService {
    private config: GoogleAuthConfig;
    private onTokensUpdated: (tokens: GoogleTokens) => Promise<void>;
    private tokens: GoogleTokens | null = null;

    constructor(
        config: GoogleAuthConfig,
        tokens: GoogleTokens | null,
        onTokensUpdated: (tokens: GoogleTokens) => Promise<void>
    ) {
        this.config = config;
        this.tokens = tokens;
        this.onTokensUpdated = onTokensUpdated;
    }

    updateConfig(config: GoogleAuthConfig) {
        this.config = config;
    }

    updateTokens(tokens: GoogleTokens | null) {
        this.tokens = tokens;
    }

    get isAuthenticated(): boolean {
        return !!(this.tokens && this.tokens.refreshToken);
    }

    /**
     * Start the OAuth 2.0 authorization flow.
     * Opens the user's browser to Google's consent screen and
     * listens on a temporary localhost server for the redirect.
     */
    async startAuthFlow(): Promise<void> {
        if (!this.config.clientId || !this.config.clientSecret) {
            new Notice(
                "Please enter your Google Client ID and Client Secret first."
            );
            return;
        }

        return new Promise<void>((resolve, reject) => {
            const server = http.createServer();
            let settled = false;

            // Listen on a random available port
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                    reject(new Error("Failed to start local server"));
                    return;
                }

                const port = address.port;
                const redirectUri = `http://127.0.0.1:${port}`;

                const authUrl = new URL(GOOGLE_AUTH_URL);
                authUrl.searchParams.set("client_id", this.config.clientId);
                authUrl.searchParams.set("redirect_uri", redirectUri);
                authUrl.searchParams.set("response_type", "code");
                authUrl.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
                authUrl.searchParams.set("access_type", "offline");
                authUrl.searchParams.set("prompt", "consent");

                // Open browser to consent screen
                window.open(authUrl.toString());

                server.on("request", async (req, res) => {
                    if (settled) return;

                    const url = new URL(
                        req.url || "/",
                        `http://127.0.0.1:${port}`
                    );
                    const code = url.searchParams.get("code");
                    const error = url.searchParams.get("error");

                    if (error) {
                        res.writeHead(200, { "Content-Type": "text/html" });
                        res.end(
                            "<html><body><h2>Authorization Failed</h2><p>You can close this window.</p></body></html>"
                        );
                        settled = true;
                        server.close();
                        reject(new Error(`Authorization denied: ${error}`));
                        return;
                    }

                    if (code) {
                        try {
                            await this.exchangeCodeForTokens(code, redirectUri);
                            res.writeHead(200, {
                                "Content-Type": "text/html",
                            });
                            res.end(
                                "<html><body><h2>Authorization Successful!</h2><p>You can close this window and return to Obsidian.</p></body></html>"
                            );
                            settled = true;
                            server.close();
                            new Notice(
                                "Google Calendar authorized successfully!"
                            );
                            resolve();
                        } catch (e) {
                            res.writeHead(200, {
                                "Content-Type": "text/html",
                            });
                            res.end(
                                "<html><body><h2>Authorization Failed</h2><p>Token exchange failed. Check console for details.</p></body></html>"
                            );
                            settled = true;
                            server.close();
                            reject(e);
                        }
                    }
                });

                // Timeout after 2 minutes
                setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        server.close();
                        reject(new Error("Authorization timed out"));
                    }
                }, 120000);
            });

            server.on("error", (err) => {
                if (!settled) {
                    settled = true;
                    reject(err);
                }
            });
        });
    }

    /**
     * Exchange authorization code for access and refresh tokens.
     */
    private async exchangeCodeForTokens(
        code: string,
        redirectUri: string
    ): Promise<void> {
        const body = new URLSearchParams({
            code,
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
        });

        const response = await requestUrl({
            url: GOOGLE_TOKEN_URL,
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
        });

        const data = response.json;

        if (data.error) {
            throw new Error(
                `Token exchange failed: ${data.error_description || data.error}`
            );
        }

        this.tokens = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || this.tokens?.refreshToken || "",
            expiresAt: Date.now() + (data.expires_in - 60) * 1000, // subtract 60s buffer
        };

        await this.onTokensUpdated(this.tokens);
    }

    /**
     * Refresh the access token using the stored refresh token.
     */
    async refreshAccessToken(): Promise<void> {
        if (!this.tokens?.refreshToken) {
            throw new Error("No refresh token available. Please re-authorize.");
        }

        const body = new URLSearchParams({
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            refresh_token: this.tokens.refreshToken,
            grant_type: "refresh_token",
        });

        const response = await requestUrl({
            url: GOOGLE_TOKEN_URL,
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
        });

        const data = response.json;

        if (data.error) {
            throw new Error(
                `Token refresh failed: ${data.error_description || data.error}`
            );
        }

        this.tokens = {
            accessToken: data.access_token,
            refreshToken: this.tokens.refreshToken,
            expiresAt: Date.now() + (data.expires_in - 60) * 1000,
        };

        await this.onTokensUpdated(this.tokens);
    }

    /**
     * Get a valid access token, refreshing if necessary.
     */
    async getValidAccessToken(): Promise<string> {
        if (!this.tokens) {
            throw new Error(
                "Not authenticated. Please authorize Google Calendar first."
            );
        }

        if (Date.now() >= this.tokens.expiresAt) {
            await this.refreshAccessToken();
        }

        return this.tokens!.accessToken;
    }

    /**
     * Revoke the current tokens and clear stored data.
     */
    async revokeAuth(): Promise<void> {
        if (this.tokens?.accessToken) {
            try {
                await requestUrl({
                    url: `https://oauth2.googleapis.com/revoke?token=${this.tokens.accessToken}`,
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                });
            } catch (e) {
                // Revocation can fail if token is already expired, that's okay
                console.warn("Token revocation failed:", e);
            }
        }

        this.tokens = null;
        await this.onTokensUpdated({
            accessToken: "",
            refreshToken: "",
            expiresAt: 0,
        });
        new Notice("Google Calendar authorization revoked.");
    }

    /**
     * Fetch the list of user's Google Calendars.
     */
    async listCalendars(): Promise<
        Array<{ id: string; summary: string; primary: boolean }>
    > {
        const token = await this.getValidAccessToken();
        const response = await requestUrl({
            url: "https://www.googleapis.com/calendar/v3/users/me/calendarList",
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        const data = response.json;
        if (data.error) {
            throw new Error(`Failed to list calendars: ${data.error.message}`);
        }

        return (data.items || []).map(
            (item: { id: string; summary: string; primary?: boolean }) => ({
                id: item.id,
                summary: item.summary,
                primary: !!item.primary,
            })
        );
    }
}
