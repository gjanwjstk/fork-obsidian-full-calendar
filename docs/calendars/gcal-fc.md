# Google Calendar Integration

The plugin supports direct Google Calendar integration via the Google Calendar API with OAuth 2.0 authentication. This provides full two-way sync: create, edit, and delete events in Obsidian and they sync to your Google Calendar.

## Setup

1. **Google Cloud Console**: Create OAuth 2.0 credentials (Desktop app type).
2. **Enable Google Calendar API** for your project.
3. **Obsidian**: In plugin settings, enter your Client ID and Client Secret.
4. **Authorize**: Click "Authorize Google Calendar" and complete the OAuth flow.
5. **Add calendar**: Add a new calendar source, select "Google Calendar", and choose which calendar to sync.

## Features

- Two-way sync: changes in Obsidian reflect in Google Calendar and vice versa
- Event color sync (optional): match event and calendar colors with Google's palette
- No need to make your calendar public—OAuth keeps your data private

## Alternative: ICS sync

If you prefer not to use OAuth or want read-only access, you can use the public ICS URL method instead. See the ICS calendar documentation for details.
